import { NextRequest, NextResponse } from "next/server";
import {
  getMainAppSessionCookieName,
  getMainAppSessionCookieOptions,
  isMainAppSessionWithinValidationGrace,
  readMainAppSessionCookie,
  validateMainAppSessionDetails,
  createRestrictedGraceSession,
  createMainAppSessionCookie,
  isSsoConfigured,
} from "@/lib/main-app-sso";
import {
  isExternallyBilledUser,
  POINTS_PER_SECOND,
  CNY_PER_SECOND,
} from "@/lib/main-app-billing";

export async function GET(request: NextRequest) {
  if (!isSsoConfigured()) {
    // If SSO is not configured (local dev mode), return mock user
    const devUser = {
      id: "local_dev_user",
      account: "admin@qycm.top",
      nickname: "本地开发者",
      role: "admin",
      billingAudience: "internal",
      pointsBalance: 99999,
    };
    return NextResponse.json({
      success: true,
      data: {
        user: devUser,
        devMode: true,
        billing: {
          ratePerSecond: POINTS_PER_SECOND,
          cnyPerSecond: CNY_PER_SECOND,
          isExternal: isExternallyBilledUser(devUser),
        },
      },
    });
  }

  const session = await readMainAppSessionCookie(
    request.cookies.get(getMainAppSessionCookieName())?.value,
  );
  const validation = session
    ? await validateMainAppSessionDetails(session)
    : { status: "invalid" as const, session: null };
  const sessionValidation = validation.status;
  const usesValidationGrace = Boolean(
    session &&
    sessionValidation === "unavailable" &&
    isMainAppSessionWithinValidationGrace(session),
  );

  if (session && (validation.status === "valid" || usesValidationGrace)) {
    const currentSession = validation.status === "valid"
      ? validation.session
      : createRestrictedGraceSession(session);
    const user = currentSession.user;
    const isExternal = isExternallyBilledUser(user);

    const response = NextResponse.json({
      success: true,
      data: {
        user,
        billing: {
          ratePerSecond: POINTS_PER_SECOND,
          cnyPerSecond: CNY_PER_SECOND,
          isExternal,
        },
        ssoValidation: usesValidationGrace ? "grace" : "valid",
      },
    });
    if (validation.status === "valid") {
      response.cookies.set(
        getMainAppSessionCookieName(),
        await createMainAppSessionCookie(currentSession),
        getMainAppSessionCookieOptions(currentSession.expiresAt),
      );
    }
    return response;
  }

  if (sessionValidation === "unavailable") {
    return NextResponse.json(
      { error: "Main site is temporarily unavailable. Please retry shortly." },
      {
        status: 503,
        headers: { "Retry-After": "3", "Cache-Control": "no-store" },
      },
    );
  }

  const response = NextResponse.json(
    { error: "Main-site session is invalid." },
    { status: 401 },
  );
  response.cookies.set(getMainAppSessionCookieName(), "", {
    ...getMainAppSessionCookieOptions(),
    maxAge: 0,
  });
  return response;
}
