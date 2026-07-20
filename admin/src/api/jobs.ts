import type { Job, JobInput, JobListResponse, JobResponse } from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function listJobs(signal?: AbortSignal): Promise<Job[]> {
  const res = await apiFetch('/api/jobs', { signal })
  const body = await unwrap<JobListResponse>(res)
  return body.jobs
}

export async function getJob(id: number, signal?: AbortSignal): Promise<Job> {
  const res = await apiFetch(`/api/jobs/${id}`, { signal })
  const body = await unwrap<JobResponse>(res)
  return body.job
}

export async function createJob(input: JobInput): Promise<Job> {
  const res = await apiFetch('/api/jobs', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<JobResponse>(res)
  return body.job
}

export async function updateJob(id: number, input: JobInput): Promise<Job> {
  const res = await apiFetch(`/api/jobs/${id}`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<JobResponse>(res)
  return body.job
}
