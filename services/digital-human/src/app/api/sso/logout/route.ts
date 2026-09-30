import { NextRequest, NextResponse } from "next/server";
import {
  getMainAppSessionCookieName,
  getMainAppSessionCookieOptions,
  getMainAppUrl,
} from "@/lib/main-app-sso";

export async function GET(request: NextRequest) {
  const mainAppUrl = getMainAppUrl();
  const response = NextResponse.redirect(mainAppUrl);
  response.cookies.set(getMainAppSessionCookieName(), "", {
    ...getMainAppSessionCookieOptions(),
    maxAge: 0,
  });
  return response;
}
