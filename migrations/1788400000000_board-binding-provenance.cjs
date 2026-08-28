/* eslint-disable */
// Board-binding provenance is not identifier provenance.
//
// The previous migration collapsed two different claims into one check:
//
//     state = 'linked'  =>  identifier_source = 'provider'
//
// That is only true of a provider that ASSIGNS identifiers. Trello does not —
// the short prefix on a Trello record is a string we chose and Trello echoes
// back — so the old rule forced every honest Trello link to either lie about
// where its key came from or stop being linked. It made the lie the cheaper
// option, and the live registry duly took it: `intelliforia` sat stamped
// `identifier_source = 'provider'` for a key Trello never saw.
//
// Split the two questions:
//
//   board_confirmed_at    the provider confirmed THIS BOARD exists  (any provider)
//   identifier_source     the provider ASSIGNED THIS KEY            (plane today)
//
// A link now rests on the first. The second stays mandatory for providers that
// mint their own keys, because a Plane board key routes live webhook traffic.

const LINKED_IS_CONFIRMED = `state <> 'linked' OR (
  COALESCE(board_id, '') <> ''
  AND board_confirmed_at IS NOT NULL
  AND (provider_type NOT IN ('plane', 'linear') OR identifier_source = 'provider')
)`;

const IDENTIFIER_IS_READ_BACK = `identifier_source <> 'provider' OR (
  COALESCE(identifier, '') <> ''
  AND identifier_fetched_at IS NOT NULL
)`;

exports.up = async (pgm) => {
  pgm.addColumns("project_ticket_boards", {
    board_confirmed_at: { type: "timestamptz" },
  });

  // A provider read that returned this board's key also confirmed the binding,
  // so the instant of that read is the honest confirmation instant.
  pgm.sql(`UPDATE public.project_ticket_boards
             SET board_confirmed_at = identifier_fetched_at
           WHERE state = 'linked'
             AND board_confirmed_at IS NULL
             AND identifier_fetched_at IS NOT NULL`);
  // A provider that assigns no identifiers never sourced one. Demote the claim
  // to what it always was: a proposal, with no read instant to point at.
  pgm.sql(`UPDATE public.project_ticket_boards
             SET identifier_source = 'proposed', identifier_fetched_at = NULL
           WHERE provider_type NOT IN ('plane', 'linear')
             AND identifier_source = 'provider'`);

  pgm.dropConstraint("project_ticket_boards", "project_ticket_boards_linked_is_confirmed", {
    ifExists: true,
  });
  pgm.addConstraint("project_ticket_boards", "project_ticket_boards_linked_is_confirmed", {
    check: LINKED_IS_CONFIRMED,
  });
  pgm.addConstraint("project_ticket_boards", "project_ticket_boards_identifier_is_read_back", {
    check: IDENTIFIER_IS_READ_BACK,
  });
};

exports.down = async (pgm) => {
  pgm.sql(`
    ALTER TABLE public.project_ticket_boards
      DROP CONSTRAINT IF EXISTS project_ticket_boards_identifier_is_read_back,
      DROP CONSTRAINT IF EXISTS project_ticket_boards_linked_is_confirmed,
      DROP COLUMN IF EXISTS board_confirmed_at;
  `);
  pgm.addConstraint("project_ticket_boards", "project_ticket_boards_linked_is_confirmed", {
    check: `state <> 'linked' OR (
      COALESCE(board_id, '') <> ''
      AND COALESCE(identifier, '') <> ''
      AND identifier_source = 'provider'
    )`,
  });
};
