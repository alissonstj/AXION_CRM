/**
 * Freeform-text variable tokens for scheduled/follow-up messages.
 *
 * Deliberately its own tiny implementation rather than reusing the
 * automations engine's `{{ns.prop}}` interpolation (src/lib/automations/
 * engine.ts) or the flows engine's `{{vars.KEY}}` one (src/lib/flows/
 * engine.ts) — those serve different namespaces/contexts (automation
 * run context, flow variables) and mixing syntaxes would raise the
 * risk of a token silently not matching in the wrong engine. `#token`
 * (no braces) also can't collide with either.
 *
 * v1 token set, per product decision: only #primeiroNome and
 * #nomeCompleto. Resolved at send time (not at schedule-creation time)
 * against the contact's current name, so an edited name is reflected.
 */
export function substituteMessageVariables(
  text: string,
  contact: { name?: string | null },
): string {
  const fullName = contact.name?.trim() || '';
  const firstName = fullName.split(/\s+/)[0] || '';
  return text
    .replace(/#primeiroNome/g, firstName)
    .replace(/#nomeCompleto/g, fullName);
}
