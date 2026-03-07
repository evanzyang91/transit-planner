// When adding a real DB client (e.g. pg or Prisma), use DATABASE_URL_EXPRESS from env.
export function getDb() {
  return { status: 'ok' };
}
