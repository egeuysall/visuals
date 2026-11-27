"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Spinner } from "@/components/ui/spinner";
import { type FormState, signIn, signUp } from "@/lib/server/actions";

export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const signingUp = mode === "sign-up";
  const [state, action, pending] = useActionState<FormState, FormData>(
    signingUp ? signUp : signIn,
    {},
  );
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");

  return (
    <form action={action} className="flex max-w-72 flex-col gap-5">
      <h1 className="text-sm font-semibold">{signingUp ? "create account" : "sign in"}</h1>
      <div className="flex flex-col gap-2">
        <label htmlFor="username" className="text-xs">
          username
        </label>
        <Input
          id="username"
          name="username"
          required
          autoFocus
          minLength={3}
          maxLength={24}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
          className="h-9 text-xs pointer-coarse:text-base"
        />
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="pin" className="text-xs">
          4 digit pin
        </label>
        <InputOTP
          id="pin"
          name="pin"
          maxLength={4}
          pattern="^[0-9]*$"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={setPin}
          aria-describedby="auth-error"
        >
          <InputOTPGroup>
            {[0, 1, 2, 3].map((i) => (
              <InputOTPSlot key={i} index={i} className="size-9 text-xs" />
            ))}
          </InputOTPGroup>
        </InputOTP>
      </div>
      <p id="auth-error" role="alert" className="min-h-5 text-xs text-destructive">
        {state.error}
      </p>
      <Button
        type="submit"
        size="lg"
        className="h-9"
        disabled={pending || username.length < 3 || pin.length < 4}
      >
        {pending && <Spinner />}
        {signingUp ? "create account" : "sign in"}
      </Button>
      <p className="text-xs text-muted-foreground">
        {signingUp ? "have an account? " : "new here? "}
        <Link
          href={signingUp ? "/sign-in" : "/sign-up"}
          className="text-foreground underline underline-offset-4"
        >
          {signingUp ? "sign in" : "create account"}
        </Link>
      </p>
    </form>
  );
}
