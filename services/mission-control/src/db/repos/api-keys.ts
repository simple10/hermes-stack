/**
 * apiKeysRepo — Drizzle facade over the `apiKey` table (master DB).
 *
 * Scope: eq(apiKey.orgId, ctx.orgId).
 *
 * Low-level key primitives (generateRawKey, hashKey) remain in
 * src/auth/api-keys.ts — they are crypto helpers independent of ctx or DB.
 * This repo wraps them into higher-level "mint" operations that also INSERT
 * the row.
 *
 * Two usage patterns:
 *
 *   Handler-side (ctx available):
 *     apiKeysRepo(ctx).findById(id)
 *     apiKeysRepo(ctx).listForUser(userId)
 *     apiKeysRepo(ctx).revoke(id)
 *     apiKeysRepo(ctx).mintForUser(args)
 *     apiKeysRepo(ctx).mintForAgent(agentId, args)
 *     apiKeysRepo(ctx).mintForConnector(connectorId, args)
 *     apiKeysRepo(ctx).mintAndExpireExisting(newArgs, oldKeyId, expiresAt)
 *
 *   Middleware-side static (env only, no ctx):
 *     lookupApiKey(env, hashedToken) — used by auth middleware to fetch orgId+principalType
 *
 * The mintApiKey / disableApiKey helpers in src/auth/api-keys.ts are re-exported
 * here for callers that need them directly (e.g., bootstrap route, tests).
 */
import { and, eq } from 'drizzle-orm';
import { apiKey as apiKeyTable } from '../master.ts';
import { masterClient } from '../client.ts';
import { generateRawKey, hashKey, mintApiKey, disableApiKey } from '../../auth/api-keys.ts';
import { makeId } from '../../ids.ts';
import type { AuthContext } from '../../auth/types.ts';
import type { Env } from '../client.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ApiKeyRow = typeof apiKeyTable.$inferSelect;

export interface MintForUserArgs {
  prefix: string;
  name: string;
  metadata?: Record<string, unknown>;
  permissions?: Record<string, string[]>;
}

export interface MintForAgentArgs {
  name?: string;
  metadata?: Record<string, unknown>;
  permissions?: Record<string, string[]>;
}

export interface MintForConnectorArgs {
  name?: string;
  metadata?: Record<string, unknown>;
  permissions?: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Static lookup — for auth middleware (no ctx available)
// ---------------------------------------------------------------------------

/**
 * Look up an API key row by its hashed token value.
 *
 * Used by auth middleware BEFORE ctx is constructed.  Returns the full row
 * (including orgId, principalType, metadata) or null if not found.
 *
 * Note: better-auth's verifyApiKey already validates the key; this lookup
 * is a follow-up to retrieve our additionalFields (orgId, principalType)
 * that verifyApiKey does not surface.
 */
export async function lookupApiKey(env: Env, hashedToken: string): Promise<ApiKeyRow | null> {
  const master = masterClient(env);
  const rows = await master
    .select()
    .from(apiKeyTable)
    .where(eq(apiKeyTable.key, hashedToken))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Factory — for handlers (ctx available)
// ---------------------------------------------------------------------------

export function apiKeysRepo(ctx: AuthContext) {
  const master = masterClient(ctx.env);
  const scope = eq(apiKeyTable.orgId, ctx.orgId);

  return {
    async findById(id: string): Promise<ApiKeyRow | null> {
      const rows = await master
        .select()
        .from(apiKeyTable)
        .where(and(scope, eq(apiKeyTable.id, id)))
        .limit(1);
      return rows[0] ?? null;
    },

    async listForUser(userId: string): Promise<ApiKeyRow[]> {
      return master
        .select()
        .from(apiKeyTable)
        .where(and(scope, eq(apiKeyTable.userId, userId)));
    },

    /**
     * Revoke (disable) a key immediately.
     */
    async revoke(id: string): Promise<void> {
      await disableApiKey(master, id);
    },

    /**
     * Mint a Personal Access Token for a user.
     * Returns { id, rawKey } — rawKey must be shown to the user exactly once.
     */
    async mintForUser(args: MintForUserArgs): Promise<{ id: string; rawKey: string }> {
      return mintApiKey(master, {
        prefix: args.prefix,
        name: args.name,
        userId: ctx.viaUserId ?? ctx.principal.id,
        orgId: ctx.orgId,
        principalType: 'pat',
        metadata: args.metadata,
        permissions: args.permissions,
      });
    },

    /**
     * Mint an API key for an agent (principalType='agent').
     */
    async mintForAgent(
      agentId: string,
      args: MintForAgentArgs = {},
    ): Promise<{ id: string; rawKey: string }> {
      return mintApiKey(master, {
        prefix: 'mcagt_',
        name: args.name ?? `agent key: ${agentId}`,
        userId: ctx.viaUserId ?? ctx.principal.id,
        orgId: ctx.orgId,
        principalType: 'agent',
        metadata: { agent_id: agentId, ...args.metadata },
        permissions: args.permissions,
      });
    },

    /**
     * Mint an API key for a connector (principalType='connector').
     */
    async mintForConnector(
      connectorId: string,
      args: MintForConnectorArgs = {},
    ): Promise<{ id: string; rawKey: string }> {
      return mintApiKey(master, {
        prefix: 'mccnn_',
        name: args.name ?? `connector key: ${connectorId}`,
        userId: ctx.viaUserId ?? ctx.principal.id,
        orgId: ctx.orgId,
        principalType: 'connector',
        metadata: { connector_id: connectorId, ...args.metadata },
        permissions: args.permissions,
      });
    },

    /**
     * Mint a new key and expire the existing one with a grace window.
     *
     * Used by agent/connector rotate-key routes (Amendment D).
     * Atomically (sequentially):
     *   1. Mint new key.
     *   2. Set the old key's expiresAt = expiresAt (ms timestamp).
     *
     * Returns { newKey: rawKey, oldExpiresAt }.
     */
    async mintAndExpireExisting(
      newKeyFactory: () => Promise<{ id: string; rawKey: string }>,
      oldKeyId: string,
      expiresAt: number,
    ): Promise<{ newKey: string; oldExpiresAt: Date }> {
      const { rawKey } = await newKeyFactory();
      await disableApiKey(master, oldKeyId, expiresAt);
      return { newKey: rawKey, oldExpiresAt: new Date(expiresAt) };
    },

    table: apiKeyTable,
  };
}
