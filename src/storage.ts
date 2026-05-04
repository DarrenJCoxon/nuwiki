/**
 * `@nusoft/nuwiki/storage` — `ObjectStorageAdapter` reference implementations.
 *
 * Per [D018](../../../nuos/docs/build/decisions/D018-document-store-as-first-class-adapter.md),
 * NuOS composes with the consumer's existing document store rather than
 * duplicating file storage. Three providers cover ~99% of real deployments:
 *
 * - SharePoint (Microsoft 365) — `SharePointObjectStorageAdapter`
 * - Google Drive (Google Workspace) — `GoogleDriveObjectStorageAdapter`
 * - Supabase Storage (greenfield deployments) — `SupabaseObjectStorageAdapter`
 *
 * Plus an in-memory adapter for tests.
 *
 * Adapters do not bundle provider SDKs. Each accepts a generic HTTP client
 * (`HttpClient`) so consumers wire their preferred fetch implementation, and
 * a per-call `getAuthToken()` so tokens can rotate without restarting the runtime.
 */

import type { ObjectStorageAdapter } from './adapters.js';
import type { ObjectStorageRef } from './types.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type HttpClient = (url: string, init?: RequestInit) => Promise<Response>;

const defaultHttp: HttpClient = (url, init) => fetch(url, init);

function bodyAsBytes(body: string | Uint8Array): Uint8Array {
  return typeof body === 'string' ? new TextEncoder().encode(body) : body;
}

function bodyAsString(body: string | Uint8Array): string {
  return typeof body === 'string' ? body : new TextDecoder().decode(body);
}

// ---------------------------------------------------------------------------
// In-memory adapter — for tests
// ---------------------------------------------------------------------------

export class InMemoryObjectStorageAdapter implements ObjectStorageAdapter {
  readonly #store = new Map<string, { body: Uint8Array; contentType?: string }>();

  async put(ref: ObjectStorageRef, body: string | Uint8Array): Promise<ObjectStorageRef> {
    const bytes = bodyAsBytes(body);
    this.#store.set(ref.key, { body: bytes, contentType: ref.contentType });
    return { ...ref, bytes: bytes.byteLength };
  }

  async get(ref: ObjectStorageRef): Promise<string> {
    const entry = this.#store.get(ref.key);
    if (!entry) throw new Error(`Object not found: ${ref.key}`);
    return bodyAsString(entry.body);
  }

  async delete(ref: ObjectStorageRef): Promise<void> {
    this.#store.delete(ref.key);
  }

  async exists(ref: ObjectStorageRef): Promise<boolean> {
    return this.#store.has(ref.key);
  }
}

// ---------------------------------------------------------------------------
// SharePoint adapter (Microsoft Graph)
// ---------------------------------------------------------------------------

export interface SharePointConfig {
  /** Tenant-rooted Graph site ID, e.g. `contoso.sharepoint.com,abcd...` */
  siteId: string;
  /** Drive ID inside the site (often the default documents drive). */
  driveId: string;
  /** Returns a fresh OAuth bearer token. Called per request so tokens can rotate. */
  getAuthToken: () => Promise<string>;
  /** HTTP client. Defaults to `globalThis.fetch`. */
  http?: HttpClient;
  /** Microsoft Graph endpoint base. Defaults to the v1.0 endpoint. */
  graphEndpoint?: string;
}

export class SharePointObjectStorageAdapter implements ObjectStorageAdapter {
  readonly #config: SharePointConfig;
  readonly #http: HttpClient;
  readonly #endpoint: string;

  constructor(config: SharePointConfig) {
    this.#config = config;
    this.#http = config.http ?? defaultHttp;
    this.#endpoint = config.graphEndpoint ?? 'https://graph.microsoft.com/v1.0';
  }

  #itemUrl(key: string): string {
    const path = encodeURI(key.replace(/^\/+/, ''));
    return `${this.#endpoint}/sites/${this.#config.siteId}/drives/${this.#config.driveId}/root:/${path}`;
  }

  async #headers(): Promise<Record<string, string>> {
    const token = await this.#config.getAuthToken();
    return { Authorization: `Bearer ${token}` };
  }

  async put(ref: ObjectStorageRef, body: string | Uint8Array): Promise<ObjectStorageRef> {
    const bytes = bodyAsBytes(body);
    const url = `${this.#itemUrl(ref.key)}:/content`;
    const baseHeaders = await this.#headers();
    const res = await this.#http(url, {
      method: 'PUT',
      headers: { ...baseHeaders, 'Content-Type': ref.contentType ?? 'application/octet-stream' },
      body: bytes,
    });
    if (!res.ok) throw new Error(`SharePoint put failed: ${res.status} ${res.statusText}`);
    return { ...ref, bytes: bytes.byteLength };
  }

  async get(ref: ObjectStorageRef): Promise<string> {
    const url = `${this.#itemUrl(ref.key)}:/content`;
    const res = await this.#http(url, { method: 'GET', headers: await this.#headers() });
    if (!res.ok) throw new Error(`SharePoint get failed: ${res.status} ${res.statusText}`);
    return res.text();
  }

  async delete(ref: ObjectStorageRef): Promise<void> {
    const res = await this.#http(this.#itemUrl(ref.key), {
      method: 'DELETE',
      headers: await this.#headers(),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`SharePoint delete failed: ${res.status} ${res.statusText}`);
    }
  }

  async exists(ref: ObjectStorageRef): Promise<boolean> {
    const res = await this.#http(this.#itemUrl(ref.key), {
      method: 'GET',
      headers: await this.#headers(),
    });
    return res.ok;
  }
}

// ---------------------------------------------------------------------------
// Google Drive adapter
// ---------------------------------------------------------------------------

export interface GoogleDriveConfig {
  /** Drive ID for shared drive deployments. Omit for the user's My Drive. */
  driveId?: string;
  /** Returns a fresh OAuth bearer token. */
  getAuthToken: () => Promise<string>;
  http?: HttpClient;
  /** API base. Defaults to `https://www.googleapis.com`. */
  apiEndpoint?: string;
}

export class GoogleDriveObjectStorageAdapter implements ObjectStorageAdapter {
  readonly #config: GoogleDriveConfig;
  readonly #http: HttpClient;
  readonly #endpoint: string;

  constructor(config: GoogleDriveConfig) {
    this.#config = config;
    this.#http = config.http ?? defaultHttp;
    this.#endpoint = config.apiEndpoint ?? 'https://www.googleapis.com';
  }

  async #headers(): Promise<Record<string, string>> {
    const token = await this.#config.getAuthToken();
    return { Authorization: `Bearer ${token}` };
  }

  /**
   * Drive uses opaque file IDs rather than paths. NuWiki's `ObjectStorageRef.key`
   * holds the file ID once a file has been created. For the initial create
   * (when there is no ID yet) the key is treated as a display name and a
   * Drive ID is allocated — the returned ref carries the new ID.
   */
  async put(ref: ObjectStorageRef, body: string | Uint8Array): Promise<ObjectStorageRef> {
    const bytes = bodyAsBytes(body);
    const baseHeaders = await this.#headers();
    const isUpdate = ref.key.startsWith('drive_id:');

    if (isUpdate) {
      const id = ref.key.slice('drive_id:'.length);
      const url = `${this.#endpoint}/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=media`;
      const res = await this.#http(url, {
        method: 'PATCH',
        headers: { ...baseHeaders, 'Content-Type': ref.contentType ?? 'application/octet-stream' },
        body: bytes,
      });
      if (!res.ok) throw new Error(`Drive put failed: ${res.status} ${res.statusText}`);
      return { ...ref, bytes: bytes.byteLength };
    }

    const metadata: Record<string, unknown> = { name: ref.key };
    if (this.#config.driveId) {
      metadata.driveId = this.#config.driveId;
      metadata.parents = [this.#config.driveId];
    }
    const boundary = '----nuwiki-' + Math.random().toString(36).slice(2);
    const multipart =
      `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) + '\r\n' +
      `--${boundary}\r\n` +
      `Content-Type: ${ref.contentType ?? 'application/octet-stream'}\r\n\r\n` +
      bodyAsString(bytes) + '\r\n' +
      `--${boundary}--`;
    const url = `${this.#endpoint}/upload/drive/v3/files?uploadType=multipart${this.#config.driveId ? '&supportsAllDrives=true' : ''}`;
    const res = await this.#http(url, {
      method: 'POST',
      headers: { ...baseHeaders, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multipart,
    });
    if (!res.ok) throw new Error(`Drive put failed: ${res.status} ${res.statusText}`);
    const created = (await res.json()) as { id: string };
    return { ...ref, key: `drive_id:${created.id}`, bytes: bytes.byteLength };
  }

  async get(ref: ObjectStorageRef): Promise<string> {
    const id = this.#extractId(ref.key);
    const url = `${this.#endpoint}/drive/v3/files/${encodeURIComponent(id)}?alt=media${this.#config.driveId ? '&supportsAllDrives=true' : ''}`;
    const res = await this.#http(url, { method: 'GET', headers: await this.#headers() });
    if (!res.ok) throw new Error(`Drive get failed: ${res.status} ${res.statusText}`);
    return res.text();
  }

  async delete(ref: ObjectStorageRef): Promise<void> {
    const id = this.#extractId(ref.key);
    const url = `${this.#endpoint}/drive/v3/files/${encodeURIComponent(id)}${this.#config.driveId ? '?supportsAllDrives=true' : ''}`;
    const res = await this.#http(url, { method: 'DELETE', headers: await this.#headers() });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Drive delete failed: ${res.status} ${res.statusText}`);
    }
  }

  async exists(ref: ObjectStorageRef): Promise<boolean> {
    const id = this.#extractId(ref.key);
    const url = `${this.#endpoint}/drive/v3/files/${encodeURIComponent(id)}?fields=id${this.#config.driveId ? '&supportsAllDrives=true' : ''}`;
    const res = await this.#http(url, { method: 'GET', headers: await this.#headers() });
    return res.ok;
  }

  #extractId(key: string): string {
    return key.startsWith('drive_id:') ? key.slice('drive_id:'.length) : key;
  }
}

// ---------------------------------------------------------------------------
// Supabase Storage adapter
// ---------------------------------------------------------------------------

export interface SupabaseStorageConfig {
  /** Supabase project URL, e.g. `https://xyz.supabase.co`. */
  url: string;
  /** Bucket name. */
  bucket: string;
  /** Service-role key (or RLS-allowed anon key for restricted operations). */
  getAuthToken: () => Promise<string>;
  http?: HttpClient;
}

export class SupabaseObjectStorageAdapter implements ObjectStorageAdapter {
  readonly #config: SupabaseStorageConfig;
  readonly #http: HttpClient;

  constructor(config: SupabaseStorageConfig) {
    this.#config = config;
    this.#http = config.http ?? defaultHttp;
  }

  #objectUrl(key: string): string {
    return `${this.#config.url}/storage/v1/object/${encodeURIComponent(this.#config.bucket)}/${encodeURI(key.replace(/^\/+/, ''))}`;
  }

  async #headers(): Promise<Record<string, string>> {
    const token = await this.#config.getAuthToken();
    return { Authorization: `Bearer ${token}`, apikey: token };
  }

  async put(ref: ObjectStorageRef, body: string | Uint8Array): Promise<ObjectStorageRef> {
    const bytes = bodyAsBytes(body);
    const baseHeaders = await this.#headers();
    const res = await this.#http(this.#objectUrl(ref.key), {
      method: 'POST',
      headers: {
        ...baseHeaders,
        'Content-Type': ref.contentType ?? 'application/octet-stream',
        'x-upsert': 'true',
      },
      body: bytes,
    });
    if (!res.ok) throw new Error(`Supabase put failed: ${res.status} ${res.statusText}`);
    return { ...ref, bytes: bytes.byteLength };
  }

  async get(ref: ObjectStorageRef): Promise<string> {
    const res = await this.#http(this.#objectUrl(ref.key), {
      method: 'GET',
      headers: await this.#headers(),
    });
    if (!res.ok) throw new Error(`Supabase get failed: ${res.status} ${res.statusText}`);
    return res.text();
  }

  async delete(ref: ObjectStorageRef): Promise<void> {
    const res = await this.#http(this.#objectUrl(ref.key), {
      method: 'DELETE',
      headers: await this.#headers(),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Supabase delete failed: ${res.status} ${res.statusText}`);
    }
  }

  async exists(ref: ObjectStorageRef): Promise<boolean> {
    const res = await this.#http(this.#objectUrl(ref.key), {
      method: 'HEAD',
      headers: await this.#headers(),
    });
    return res.ok;
  }
}
