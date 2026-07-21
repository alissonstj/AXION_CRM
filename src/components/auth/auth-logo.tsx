// Brand mark shown above the card on auth pages (login, signup,
// forgot-password). Kept separate from the per-state icon inside each
// Card's CardHeader (MessageSquare/UsersRound/CheckCircle), which
// conveys page state and must stay untouched.
export function AuthLogo() {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/axion-logo.png"
      alt="AXION"
      className="h-20 w-auto object-contain"
    />
  );
}
