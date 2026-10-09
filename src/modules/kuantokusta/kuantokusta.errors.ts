import { ApiError } from '#/infra/http/api-error'
import { CredentialDecryptionError } from '#/modules/credentials/domain/credential-cipher'
import { InvalidCredentialError } from '#/modules/credentials/services/credentials.service'

import { RunTooSoonError } from './services/collection-runs.service'
import { KkKeyAttemptsExceededError } from './services/kk-credential.service'
import {
  InvalidKkSettingsError,
  KkSettingsMissingError
} from './services/kk-store-settings.service'
import { KkCredentialMissingError } from './services/offers-sync.service'
import {
  KkKeyRejectedError,
  KkRateLimitedError,
  KkUnavailableError,
  KkUnexpectedResponseError
} from './services/seller-api.client'

/**
 * Translates what can go wrong inside this module into an answer for the
 * caller. Each code is part of the API contract.
 *
 * Anything not listed here is rethrown as it is, and reaches the caller as
 * a plain "internal_error" with the detail kept in the log.
 */
export function toApiError(error: unknown): unknown {
  if (error instanceof InvalidCredentialError) {
    return new ApiError(400, 'invalid_request', error.message)
  }
  if (error instanceof KkKeyRejectedError) {
    return new ApiError(
      422,
      'kk_key_rejected',
      'KuantoKusta did not accept this API key'
    )
  }
  if (error instanceof KkKeyAttemptsExceededError) {
    return new ApiError(429, 'too_many_requests', error.message)
  }
  if (error instanceof KkCredentialMissingError) {
    return new ApiError(409, 'kk_key_missing', error.message)
  }
  if (error instanceof KkRateLimitedError) {
    return new ApiError(
      503,
      'kk_rate_limited',
      'KuantoKusta is limiting requests for this key; try again in a minute'
    )
  }
  if (error instanceof KkUnavailableError) {
    return new ApiError(
      503,
      'kk_unavailable',
      'KuantoKusta could not be reached; nothing was changed'
    )
  }
  if (error instanceof KkUnexpectedResponseError) {
    return new ApiError(
      502,
      'kk_unexpected_response',
      'KuantoKusta answered in a way the hub does not understand'
    )
  }
  if (error instanceof RunTooSoonError) {
    return new ApiError(
      429,
      'kk_run_too_soon',
      'A collection finished a moment ago; its result is the current one',
      { retryAfterSeconds: error.retryAfterSeconds }
    )
  }
  if (error instanceof CredentialDecryptionError) {
    return new ApiError(
      500,
      'credential_unreadable',
      'The stored key cannot be read; set it again'
    )
  }
  if (error instanceof KkSettingsMissingError) {
    return new ApiError(
      409,
      'kk_settings_missing',
      'The store\'s KuantoKusta settings are created by its first collection; '
      + 'run one first'
    )
  }
  if (error instanceof InvalidKkSettingsError) {
    return new ApiError(400, 'invalid_request', error.message)
  }
  return error
}
