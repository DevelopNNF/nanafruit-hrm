// A single S3Client aimed at Cloudflare R2 instead of AWS — R2 speaks the S3
// API, so the AWS SDK works unmodified once pointed at R2's endpoint.

import { S3Client } from '@aws-sdk/client-s3'
import { r2Config } from './config.js'

export const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${r2Config.accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: r2Config.accessKeyId,
    secretAccessKey: r2Config.secretAccessKey,
  },
})
