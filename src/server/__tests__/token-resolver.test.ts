import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveToken,
  evaluateTokenCandidates,
  maskToken,
} from '../lib/token-resolver';
import { fastcronService, resolveScheduleToken } from '../services/fastcron-service';
import * as tokenCrypto from '../lib/token-crypto';
import { dbClients } from '../db/clients';

describe('Unified FastCron Token Resolver Suite (token-resolver.ts)', () => {
  const mockWorkspaceId = '11111111-2222-3333-4444-555555555555';
  const mockTokenId = 'tok-aaaa-bbbb-cccc-dddddddddddd';
  const mockKek = 'test_token_kek_32_bytes_long_secret_1234';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Pure Candidate Evaluator (evaluateTokenCandidates)', () => {
    it('selects the first candidate with length >= 16', () => {
      const result = evaluateTokenCandidates([
        null,
        '',
        'short',
        'valid_candidate_1234567890',
        'another_valid_token_abcdef',
      ]);
      expect(result).toBe('valid_candidate_1234567890');
    });

    it('returns null when no candidate satisfies criteria', () => {
      expect(evaluateTokenCandidates([null, undefined, '', '12345', 'short_token'])).toBeNull();
      expect(evaluateTokenCandidates([])).toBeNull();
    });

    it('trims whitespace around candidates', () => {
      const result = evaluateTokenCandidates(['  token_with_whitespace_12345  ']);
      expect(result).toBe('token_with_whitespace_12345');
    });
  });

  describe('2. Canonical Token Masking (maskToken)', () => {
    it('masks token displaying only bullets and last 4 characters', () => {
      expect(maskToken('fastcron_secret_token_9876')).toBe('\u2022\u2022\u2022\u20229876');
      expect(maskToken('abc123xyz7890')).toBe('\u2022\u2022\u2022\u20227890');
    });

    it('handles short tokens without leaking full secret', () => {
      expect(maskToken('abcd')).toBe('\u2022\u2022\u2022\u2022abcd');
      expect(maskToken('ab')).toBe('\u2022\u2022\u2022\u2022ab');
    });

    it('handles empty, null, or non-string gracefully', () => {
      expect(maskToken('')).toBe('');
      expect(maskToken(null)).toBe('');
      expect(maskToken(undefined)).toBe('');
      expect(maskToken(1234 as any)).toBe('');
    });

    it('guarantees zero secret leakage for arbitrary secrets', () => {
      const secret = 'super_confidential_fastcron_api_key_XYZ1';
      const masked = maskToken(secret);
      expect(masked).toBe('\u2022\u2022\u2022\u2022XYZ1');
      expect(masked).not.toContain('super_confidential');
      expect(masked).not.toContain('fastcron_api_key');
    });
  });

  describe('3. Canonical 4-Stage Hierarchy in resolveToken()', () => {
    it('Level 1: Schedule-level encrypted token takes highest priority', async () => {
      vi.spyOn(tokenCrypto, 'resolveTokenKek').mockResolvedValue(mockKek);
      vi.spyOn(tokenCrypto, 'decryptToken').mockImplementation(async (cipher) => {
        if (cipher === 'v1:schedule_ciphertext') return 'schedule_override_token_12345678';
        if (cipher === 'v1:db_ciphertext') return 'db_token_should_be_ignored_1234';
        return null;
      });

      const schedule = {
        workspace_id: mockWorkspaceId,
        fastcron_token_id: mockTokenId,
        fastcron_token_encrypted: 'v1:schedule_ciphertext',
      };

      const result = await resolveToken(
        {
          workspaceId: mockWorkspaceId,
          tokenId: mockTokenId,
          encryptedToken: schedule.fastcron_token_encrypted,
          schedule,
        },
        'scheduling',
        { FASTCRON_API_TOKEN: 'env_token_should_be_ignored_1234' }
      );

      expect(result.token).toBe('schedule_override_token_12345678');
      expect(result.source).toBe('schedule_override');
      expect(result.maskedToken).toBe('\u2022\u2022\u2022\u20225678');
    });

    it('Level 2: Explicit fastcron_tokens row takes precedence when schedule override absent', async () => {
      vi.spyOn(tokenCrypto, 'resolveTokenKek').mockResolvedValue(mockKek);
      vi.spyOn(tokenCrypto, 'decryptToken').mockResolvedValue('token_from_db_row_12345678');

      const mockAdmin = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: mockTokenId,
                    name: 'Custom Team FastCron',
                    token_encrypted: 'v1:db_token_cipher',
                    token_masked: '\u2022\u2022\u2022\u20225678',
                    is_default: false,
                  },
                  error: null,
                }),
              }),
            }),
          }),
        }),
      };
      vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockAdmin as any);

      const result = await resolveToken(
        {
          workspaceId: mockWorkspaceId,
          tokenId: mockTokenId,
          encryptedToken: null,
        },
        'scheduling',
        { FASTCRON_API_TOKEN: 'env_fallback_token_1234' }
      );

      expect(result.token).toBe('token_from_db_row_12345678');
      expect(result.source).toBe('workspace_registry');
      expect(result.tokenId).toBe(mockTokenId);
      expect(result.name).toBe('Custom Team FastCron');
    });

    it('Level 3: Workspace default token is used when no schedule override or explicit tokenId', async () => {
      vi.spyOn(tokenCrypto, 'resolveTokenKek').mockResolvedValue(mockKek);
      vi.spyOn(tokenCrypto, 'decryptToken').mockResolvedValue('workspace_default_token_9999');

      const mockAdmin = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: 'def-tok-id',
                    name: 'Default Workspace Key',
                    token_encrypted: 'v1:default_cipher',
                    token_masked: '\u2022\u2022\u2022\u20229999',
                    is_default: true,
                  },
                  error: null,
                }),
              }),
            }),
          }),
        }),
      };
      vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockAdmin as any);

      const result = await resolveToken(
        {
          workspaceId: mockWorkspaceId,
          tokenId: null,
          encryptedToken: null,
        },
        'scheduling',
        { FASTCRON_API_TOKEN: 'env_fallback_token_1234' }
      );

      expect(result.token).toBe('workspace_default_token_9999');
      expect(result.source).toBe('workspace_registry');
      expect(result.name).toBe('Default Workspace Key');
      expect(result.maskedToken).toBe('\u2022\u2022\u2022\u20229999');
    });

    it('Level 4: Environment fallback is used when no DB tokens exist', async () => {
      vi.spyOn(tokenCrypto, 'resolveTokenKek').mockResolvedValue(mockKek);

      const mockAdmin = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          }),
        }),
      };
      vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockAdmin as any);

      const result = await resolveToken(
        {
          workspaceId: mockWorkspaceId,
          tokenId: null,
        },
        'scheduling',
        { FASTCRON_API_TOKEN: 'env_fastcron_api_token_4321' }
      );

      expect(result.token).toBe('env_fastcron_api_token_4321');
      expect(result.source).toBe('env');
      expect(result.name).toBe('Env FastCron Token');
      expect(result.maskedToken).toBe('\u2022\u2022\u2022\u20224321');
    });

    it('throws descriptive error when all 4 levels fail to find a valid token', async () => {
      vi.spyOn(tokenCrypto, 'resolveTokenKek').mockResolvedValue(mockKek);

      const mockAdmin = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          }),
        }),
      };
      vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockAdmin as any);

      await expect(
        resolveToken(
          { workspaceId: mockWorkspaceId },
          'scheduling',
          { FASTCRON_API_TOKEN: '' }
        )
      ).rejects.toThrow('No fastcron API token configured for workspace in scheduling project or server environment.');
    });
  });

  describe('4. Caller Verification (fastcronService & resolveScheduleToken)', () => {
    it('resolveScheduleToken correctly handles schedule-level encrypted tokens', async () => {
      vi.spyOn(tokenCrypto, 'resolveTokenKek').mockResolvedValue(mockKek);
      vi.spyOn(tokenCrypto, 'decryptToken').mockResolvedValue('decrypted_schedule_token_7777');

      const schedule = {
        workspace_id: mockWorkspaceId,
        fastcron_token_encrypted: 'v1:some_encrypted_value',
      };

      const token = await resolveScheduleToken(schedule, {});
      expect(token).toBe('decrypted_schedule_token_7777');
    });

    it('fastcronService.resolveFastCronToken evaluates channels and connections using evaluateTokenCandidates', async () => {
      vi.spyOn(tokenCrypto, 'resolveTokenKek').mockResolvedValue(mockKek);
      vi.spyOn(tokenCrypto, 'decryptToken').mockImplementation(async (cipher) => {
        if (cipher === 'v1:encrypted_channel') return 'channel_token_1234567890';
        return null;
      });

      // Encrypted channel token
      const t1 = await fastcronService.resolveFastCronToken(
        'v1:encrypted_channel',
        'ws_plain_token_1234567890',
        {}
      );
      expect(t1).toBe('channel_token_1234567890');

      // Plain channel token
      const t2 = await fastcronService.resolveFastCronToken(
        'plain_channel_token_1234567890',
        null,
        {}
      );
      expect(t2).toBe('plain_channel_token_1234567890');

      // Fallback to workspace token
      const t3 = await fastcronService.resolveFastCronToken(
        null,
        'workspace_plain_token_1234567890',
        {}
      );
      expect(t3).toBe('workspace_plain_token_1234567890');

      // Fallback to env token
      const t4 = await fastcronService.resolveFastCronToken(
        null,
        null,
        { FASTCRON_API_TOKEN: 'env_token_123456789012' }
      );
      expect(t4).toBe('env_token_123456789012');
    });
  });
});
