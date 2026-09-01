/**
 * Pinterest Account & Entity Validation Rules.
 * Matches Pinterest specifications:
 * - Length: 1 to 60 characters
 * - Allowed characters: Alphanumeric, underscores, periods, and hyphens (a-z, A-Z, 0-9, _, ., -)
 */
export const USERNAME_REGEX = /^[a-zA-Z0-9_.-]{1,60}$/;
