// Presigned-URL helpers for employee profile photos in R2.
//
// The browser talks to R2 directly for both the PUT (upload) and the GET
// (view) — this file only ever mints short-lived signed URLs, it never moves
// image bytes through this process.

import { randomUUID } from 'node:crypto'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import {
  EMPLOYEE_PHOTO_MAX_BYTES,
  EMPLOYEE_PHOTO_MIME_TYPES,
  type EmployeePhotoMimeType,
} from '@hrm/shared'
import { r2Config } from './config.js'
import { r2Client } from './r2Client.js'

const UPLOAD_URL_TTL_SECONDS = 5 * 60
const VIEW_URL_TTL_SECONDS = 15 * 60

const EXTENSION_BY_MIME_TYPE: Record<EmployeePhotoMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

function isEmployeePhotoMimeType(value: string): value is EmployeePhotoMimeType {
  return (EMPLOYEE_PHOTO_MIME_TYPES as readonly string[]).includes(value)
}

export type PresignPhotoUploadResult =
  | { ok: true; uploadUrl: string; key: string }
  | { ok: false; message: string }

/**
 * Validates the declared content type/size and returns a presigned PUT URL.
 *
 * ContentType and ContentLength are signed into the URL, so the browser's own
 * headers on the PUT must match exactly or R2 rejects the request — that is
 * what actually enforces the size cap and type allowlist, not just the check
 * below (a client can't declare 1 KB here and then stream more).
 */
export async function presignPhotoUpload(
  employeeId: number,
  mimeType: string,
  sizeBytes: number
): Promise<PresignPhotoUploadResult> {
  if (!isEmployeePhotoMimeType(mimeType)) {
    return {
      ok: false,
      message: `mimeType must be one of: ${EMPLOYEE_PHOTO_MIME_TYPES.join(', ')}`,
    }
  }
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > EMPLOYEE_PHOTO_MAX_BYTES) {
    return {
      ok: false,
      message: `sizeBytes must be a positive integer no greater than ${EMPLOYEE_PHOTO_MAX_BYTES}`,
    }
  }

  const key = `employees/${employeeId}/photo/${randomUUID()}.${EXTENSION_BY_MIME_TYPE[mimeType]}`

  const uploadUrl = await getSignedUrl(
    r2Client,
    new PutObjectCommand({
      Bucket: r2Config.bucket,
      Key: key,
      ContentType: mimeType,
      ContentLength: sizeBytes,
    }),
    { expiresIn: UPLOAD_URL_TTL_SECONDS }
  )

  return { ok: true, uploadUrl, key }
}

export async function presignPhotoView(key: string): Promise<string> {
  return getSignedUrl(
    r2Client,
    new GetObjectCommand({ Bucket: r2Config.bucket, Key: key }),
    { expiresIn: VIEW_URL_TTL_SECONDS }
  )
}

/** Confirms the object actually landed in R2 before the caller trusts it. */
export async function headPhoto(key: string): Promise<boolean> {
  try {
    await r2Client.send(new HeadObjectCommand({ Bucket: r2Config.bucket, Key: key }))
    return true
  } catch {
    return false
  }
}

/** Best-effort: never let R2 cleanup fail the request that triggered it. */
export async function deletePhotoObject(key: string): Promise<void> {
  try {
    await r2Client.send(new DeleteObjectCommand({ Bucket: r2Config.bucket, Key: key }))
  } catch (err) {
    console.error(`failed to delete R2 object ${key}`, err)
  }
}
