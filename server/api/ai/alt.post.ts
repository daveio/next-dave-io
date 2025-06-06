import { recordAPIErrorMetrics, recordAPIMetrics } from "~/server/middleware/metrics"
import { requireAIAuth } from "~/server/utils/auth-helpers"
import { getCloudflareEnv } from "~/server/utils/cloudflare"
import { createApiError, createApiResponse, isApiError, logRequest } from "~/server/utils/response"
import { AiAltTextRequestSchema } from "~/server/utils/schemas"

export default defineEventHandler(async (event) => {
  try {
    // Check authorization for AI alt text generation using helper
    const auth = await requireAIAuth(event, "alt")

    // Get environment bindings using helper
    const env = getCloudflareEnv(event)

    // Parse and validate request body
    const body = await readBody(event)
    const request = AiAltTextRequestSchema.parse(body)

    const startTime = Date.now()

    // Process the image data
    let imageData: Buffer

    if (request.url) {
      // Fetch image from URL
      try {
        const response = await fetch(request.url)
        if (!response.ok) {
          createApiError(400, `Failed to fetch image: ${response.statusText}`)
        }

        const contentType = response.headers.get("content-type")
        if (!contentType?.startsWith("image/")) {
          createApiError(400, "URL does not point to an image")
        }

        imageData = Buffer.from(await response.arrayBuffer())
      } catch (error) {
        createApiError(400, `Failed to fetch image from URL: ${error}`)
      }
    } else if (request.image) {
      // Decode base64 image
      try {
        imageData = Buffer.from(request.image, "base64")
      } catch {
        createApiError(400, "Invalid base64 image data")
      }
    } else {
      createApiError(400, "Either url or image must be provided")
    }

    // Validate image size
    if (imageData.length > 10 * 1024 * 1024) {
      // 10MB limit
      createApiError(400, "Image too large (max 10MB)")
    }

    // Use Cloudflare AI for image analysis
    let altText: string
    const aiModel = "@cf/llava-hf/llava-1.5-7b-hf"

    if (!env?.AI) {
      throw createApiError(503, "AI service not available")
    }

    let _aiSuccess = false
    let _aiErrorType: string | undefined

    try {
      const result = (await env.AI.run(aiModel as "@cf/llava-hf/llava-1.5-7b-hf", {
        image: Array.from(new Uint8Array(imageData)),
        prompt:
          "Describe this image in detail for use as alt text. Focus on the main subjects, actions, and important visual elements that would help someone understand the image content. Be concise but descriptive.",
        max_tokens: 150
      })) as { description?: string; text?: string }

      altText = result.description || result.text || "Unable to generate description"

      // Clean up the AI response
      altText = altText.trim()
      if (altText.length > 300) {
        altText = `${altText.substring(0, 297)}...`
      }

      _aiSuccess = true
    } catch (error) {
      console.error("AI processing failed:", error)
      _aiSuccess = false
      _aiErrorType = error instanceof Error ? error.name : "UnknownError"
      throw createApiError(500, "Failed to process image with AI")
    }

    const processingTime = Date.now() - startTime

    // Record successful AI request
    recordAPIMetrics(event, 200)

    // Log successful request
    logRequest(event, "ai/alt", "POST", 200, {
      user: auth.payload?.sub || "anonymous",
      imageSize: imageData.length,
      processingTime,
      success: true
    })

    return createApiResponse(
      {
        altText,
        imageSource: request.url || "uploaded-file",
        model: aiModel,
        timestamp: new Date().toISOString(),
        processingTimeMs: processingTime,
        imageSizeBytes: imageData.length
      },
      "Alt text generated successfully"
    )
  } catch (error: unknown) {
    console.error("AI alt-text error:", error)

    // Record failed AI request
    recordAPIErrorMetrics(event, error)

    // Log error request
    // biome-ignore lint/suspicious/noExplicitAny: Type assertion needed for error handling
    const statusCode = isApiError(error) ? (error as any).statusCode || 500 : 500
    logRequest(event, "ai/alt", "POST", statusCode, {
      user: "unknown",
      imageSize: 0,
      processingTime: 0,
      success: false
    })

    // Re-throw API errors
    if (isApiError(error)) {
      throw error
    }

    throw createApiError(500, "Failed to generate alt text")
  }
})
