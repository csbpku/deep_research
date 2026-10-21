import { NextResponse } from 'next/server';

/** Stop development-only reviews before App Router begins streaming a 200. */
export function middleware() {
  if (process.env.NODE_ENV === 'production') {
    return new NextResponse('Not found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  return NextResponse.next();
}

// Deliberately scoped: no auth, API, or ordinary page requests are intercepted.
export const config = { matcher: ['/mui-demo/:path*'] };
