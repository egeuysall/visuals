"use server";

import { redirect } from "next/navigation";
import { checkUser, createUser, endSession, startSession, validateCredentials } from "./auth";

export interface FormState {
  error?: string;
  username?: string;
}

async function authenticate(form: FormData, resolve: typeof checkUser): Promise<FormState> {
  const username = String(form.get("username") ?? "")
    .trim()
    .toLowerCase();
  const pin = String(form.get("pin") ?? "");
  const invalid = validateCredentials(username, pin);
  if (invalid) return { error: invalid, username };
  const user = resolve(username, pin);
  if ("error" in user) return { error: user.error, username };
  await startSession(user.id);
  redirect("/app");
}

export async function signIn(_: FormState, form: FormData) {
  return authenticate(form, checkUser);
}

export async function signUp(_: FormState, form: FormData) {
  return authenticate(form, createUser);
}

export async function signOut() {
  await endSession();
  redirect("/");
}
