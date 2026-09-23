/**
 * The sentence the agent says before anything else.
 *
 * ElevenLabs calls this once, as it sets the conversation up, and uses the
 * variables it returns. Picking the greeting here rather than in the prompt is
 * not a detail: a model told to "choose one at random" settles on the first
 * option after a while, and a company whose switchboard says the exact same
 * fourteen words to every caller sounds like a recording. Randomness belongs
 * where randomness actually exists.
 *
 * It also saves the dead air of generating an opening line. The greeting is
 * chosen before the caller hears anything, not after.
 *
 * No secret guards this route, because it discloses nothing: it takes no input
 * it trusts and returns one of three fixed sentences. That stops being true the
 * day it recognises a returning caller by their number — ElevenLabs sends it —
 * and greets them by name. Authenticate it before that day, not after.
 */

import { json } from '../lib/http';

/**
 * Written to be heard, not read. Each opens with the company name, because a
 * caller who has just dialled needs to know the call connected, and ends on an
 * open question — the client says what is wrong in their own words, and that
 * sentence is worth more than any form field.
 */
const GREETINGS = [
  'SOS Cumulus bonjour ! Marie à votre écoute, comment puis-je vous aider ?',
  'SOS Cumulus bonjour ! Marie à l’appareil, que puis-je pour vous ?',
  'Bonjour, je suis Marie de SOS Cumulus, en quoi puis-je vous aider ?',
];

/**
 * Every variable the agent declares has to come back, greeting or not —
 * ElevenLabs rejects a payload that omits one. The rest are filled by tool
 * responses later in the call; they only need to exist now.
 */
const EMPTY_VARS = {
  case_token: '',
  case_ref: '',
  handover: '',
  client_first_name: '',
  client_last_name: '',
  client_phone: '',
};

export function handleGreeting(): Response {
  const greeting = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];

  return json({
    type: 'conversation_initiation_client_data',
    dynamic_variables: { ...EMPTY_VARS, greeting },
  });
}
