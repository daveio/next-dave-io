import { recordAPIErrorMetrics, recordAPIMetrics } from "~/server/middleware/metrics"
import { authorizeEndpoint } from "~/server/utils/auth"
import { getCloudflareEnv } from "~/server/utils/cloudflare"
import { createApiError, createApiResponse, isApiError } from "~/server/utils/response"
import { TokenMetricsSchema, TokenUsageSchema } from "~/server/utils/schemas"

interface TokenUsageData {
  token_id: string
  usage_count: number
  max_requests: number
  created_at: string
  last_used: string
}

export default defineEventHandler(async (event) => {
  const _startTime = Date.now()
  let _authToken: string | null = null
  let uuid: string | undefined
  let path: string | undefined

  try {
    // Check authorization for token management
    const authFunc = await authorizeEndpoint("api", "tokens")
    const auth = await authFunc(event)
    if (!auth.success) {
      throw createApiError(401, auth.error || "Unauthorized")
    }

    _authToken = auth.payload?.sub || null

    // Get environment bindings using helper
    const env = getCloudflareEnv(event)
    if (!env?.DATA) {
      throw createApiError(503, "Token service not available")
    }

    uuid = getRouterParam(event, "uuid")
    path = getRouterParam(event, "path")

    if (!uuid) {
      throw createApiError(400, "Token UUID is required")
    }

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    if (!uuidRegex.test(uuid)) {
      throw createApiError(400, "Invalid UUID format")
    }

    // Handle different paths
    if (!path) {
      // GET /api/tokens/{uuid} - Get token usage using simple KV keys
      const [usageCountStr, maxRequestsStr, createdAtStr, lastUsedStr] = await Promise.all([
        env.DATA.get(`token:${uuid}:usage-count`),
        env.DATA.get(`token:${uuid}:max-requests`),
        env.DATA.get(`token:${uuid}:created-at`),
        env.DATA.get(`token:${uuid}:last-used`)
      ])

      // Check if token exists
      if (!createdAtStr && !maxRequestsStr) {
        throw createApiError(404, `Token not found: ${uuid}`)
      }

      const usage: TokenUsageData = {
        token_id: uuid,
        usage_count: usageCountStr ? Number.parseInt(usageCountStr, 10) : 0,
        max_requests: maxRequestsStr ? Number.parseInt(maxRequestsStr, 10) : 0,
        created_at: createdAtStr || new Date().toISOString(),
        last_used: lastUsedStr || ""
      }

      const validatedUsage = TokenUsageSchema.parse(usage)

      // Record successful metrics
      recordAPIMetrics(event, 200)

      return createApiResponse(validatedUsage, "Token usage retrieved successfully")
    }
    if (path === "revoke") {
      // GET /api/tokens/{uuid}/revoke - Revoke token (legacy endpoint)
      const createdAtStr = await env.DATA.get(`token:${uuid}:created-at`)

      if (!createdAtStr) {
        throw createApiError(404, `Token not found: ${uuid}`)
      }

      // Add the token to revocation using simple KV key
      await env.DATA.put(`token:${uuid}:revoked`, "true", { expirationTtl: 86400 * 30 })

      console.log(`Token revoked: ${uuid}`)

      const revokeData = {
        revoked: true,
        token_id: uuid,
        revoked_at: new Date().toISOString()
      }

      // Record successful metrics
      recordAPIMetrics(event, 200)

      return createApiResponse(revokeData, "Token revoked successfully")
    }
    if (path === "metrics") {
      // GET /api/tokens/{uuid}/metrics - Get token metrics using simple KV keys
      const createdAtStr = await env.DATA.get(`token:${uuid}:created-at`)

      if (!createdAtStr) {
        throw createApiError(404, `Token not found: ${uuid}`)
      }

      // Get real metrics data from KV counters for this specific token
      const [totalRequests, successfulRequests, failedRequests] = await Promise.all([
        env.DATA.get(`metrics:tokens:${uuid}:requests:total`).then((v) => Number.parseInt(v || "0")),
        env.DATA.get(`metrics:tokens:${uuid}:requests:successful`).then((v) => Number.parseInt(v || "0")),
        env.DATA.get(`metrics:tokens:${uuid}:requests:failed`).then((v) => Number.parseInt(v || "0"))
      ])

      const metrics = TokenMetricsSchema.parse({
        success: true,
        data: {
          total_requests: totalRequests,
          successful_requests: successfulRequests,
          failed_requests: failedRequests,
          redirect_clicks: 0
        },
        timestamp: new Date().toISOString()
      })

      // Record successful metrics
      recordAPIMetrics(event, 200)

      return metrics
    }
    throw createApiError(404, `Unknown token endpoint: ${path}`)
  } catch (error: unknown) {
    console.error("Token management error:", error)

    // Record error metrics
    recordAPIErrorMetrics(event, error)

    // Re-throw API errors
    if (isApiError(error)) {
      throw error
    }

    throw createApiError(500, "Token management failed")
  }
})
