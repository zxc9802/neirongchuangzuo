import AuthForm from "@/components/AuthForm";
import { supportsStandaloneAuth } from "@/lib/auth-mode";
import { notFound, redirect } from "next/navigation";

import { cookies } from "next/headers";
import { AUTH_COOKIE, readStandaloneSession } from "@/lib/server/standalone-auth";

export const dynamic = "force-dynamic";
export default async function LoginPage() {
  if (!supportsStandaloneAuth()) notFound();
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  if (await readStandaloneSession(token)) redirect("/");
  return <AuthForm mode="login" />;
}
