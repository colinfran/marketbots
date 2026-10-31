import { requestSignatures, streamTokens } from "@mb/core/stream-token"

export { STREAM_TOKEN_TTL_SECONDS, type StreamTokenPayload, type TokenCheck } from "@mb/core/stream-token"

/**
 * Short-lived tokens for the engine's WebSocket stream (@mb/core/stream-token), bound to crypto's
 * HMAC context prefix `cmb-stream.`: a stock bot token never verifies here, even with the same
 * secret.
 */
const tokens = streamTokens("cmb-stream.")

export const signStreamToken = tokens.sign

export const verifyStreamToken = tokens.verify

/** The dashboard's signed requests to the engine (its commands), bound to `cmb-request.` in the same way. */
const requests = requestSignatures("cmb-request.")

export const signEngineRequest = requests.sign

export const verifyEngineRequest = requests.verify
