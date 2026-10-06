export const VERIFICATION_ENABLED_ENV = 'KIMI_CODE_EXPERIMENTAL_GOAL_VERIFICATION';

export function isVerificationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[VERIFICATION_ENABLED_ENV];
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}