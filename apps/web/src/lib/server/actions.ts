"use server";

import { redirect } from "next/navigation";
import {
  allowAddress,
  checkUser,
  createUser,
  endSession,
  startSession,
  validateCredentials,
} from "./auth";

export interface FormState {
  error?: string;
  username?: string;
}

async function authenticate(form: FormData, action: "sign-in" | "sign-up"): Promise<FormState> {
  const username = String(form.get("username") ?? "")
    .trim()
    .toLowerCase();
  const pin = String(form.get("pin") ?? "");
  const invalid = validateCredentials(username, pin);
  if (invalid) return { error: invalid, username };
  if (!(await allowAddress(action)))
    return { error: "too many tries from this network today.", username };
  const user = await (action === "sign-up" ? createUser : checkUser)(username, pin);
  if ("error" in user) return { error: user.error, username };
  await startSession(user.id);
  redirect("/app");
}

export async function signIn(_: FormState, form: FormData) {
  return authenticate(form, "sign-in");
}

export async function signUp(_: FormState, form: FormData) {
  return authenticate(form, "sign-up");
}

export async function signOut() {
  await endSession();
  redirect("/");
}
