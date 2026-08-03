// Cloudflare R2 settings, read once at startup.
//
// Same reasoning as auth/config.ts: these are required, not optional-with-a-
// default, so a missing value crashes the server on boot instead of failing
// the first upload a user tries.

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`${name} is not set — see server/.env.example`)
  }
  return value
}

export const r2Config = {
  accountId: requireEnv('R2_ACCOUNT_ID'),
  accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
  secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
  bucket: requireEnv('R2_BUCKET'),
} as const
