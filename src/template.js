/**
 * A deliberately tiny template language, so message copy can live in
 * config/messages.json and be edited by whoever writes to clients.
 *
 *   {name}        -> substituted, or removed if empty
 *   [[ ... ]]     -> optional group: dropped entirely if any {name} inside is
 *                    missing or empty. Lets copy read naturally whether or not
 *                    a card has a launch time, a hub link, and so on.
 */

const GROUP = /\[\[([\s\S]*?)\]\]/g;
const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

function isEmpty(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function substitute(text, values) {
  return text.replace(PLACEHOLDER, (_, key) =>
    isEmpty(values[key]) ? '' : String(values[key]),
  );
}

export function renderTemplate(template, values = {}) {
  const withGroups = String(template).replace(GROUP, (_, inner) => {
    const keys = [...inner.matchAll(PLACEHOLDER)].map((match) => match[1]);
    if (keys.some((key) => isEmpty(values[key]))) return '';
    return substitute(inner, values);
  });

  return substitute(withGroups, values)
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Placeholder names a template refers to — used to validate config at boot. */
export function templateKeys(template) {
  return [...String(template).matchAll(PLACEHOLDER)].map((match) => match[1]);
}
