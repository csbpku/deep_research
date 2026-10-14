/** 非 admin 只能看到打码邮箱（用于同名区分），如 a***@example.com。 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}
