import { isBootstrapAdminEmail } from './invitation';

/** Beta mode admits existing accounts plus the bootstrap Admin only. */
export function canCreateAccountInBeta(input: {
  betaMode: boolean;
  email: string;
  existingUser: unknown | null;
  bootstrapAdminEmail: string;
}): boolean {
  if (!input.betaMode) return true;
  if (input.existingUser) return true;
  return isBootstrapAdminEmail(input.email, input.bootstrapAdminEmail);
}
