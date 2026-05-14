export { default } from "next-auth/middleware";

// Protege todas las rutas excepto: /login, /api/auth/*, assets de Next, favicon
// y los Excel descargables que llevan su propia validación de path.
export const config = {
  matcher: [
    "/((?!login|api/auth|_next/static|_next/image|favicon.ico).*)",
  ],
};
