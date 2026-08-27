"use strict";

const CONTENT_FIRST_OWNER_SELECTION = Object.freeze({ mode: "content-first" });

function finiteNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizedNfcString(value) {
  return typeof value === "string" && value.length > 0 ? value.normalize("NFC") : null;
}

function normalizeOwnerSelectionPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return CONTENT_FIRST_OWNER_SELECTION;
  }
  if (value.mode !== "titleContains") {
    return CONTENT_FIRST_OWNER_SELECTION;
  }
  const titleNeedle = normalizedNfcString(value.titleNeedle);
  const deck1MetadataWaitMs = finiteNonNegativeInteger(value.deck1MetadataWaitMs);
  if (!titleNeedle || deck1MetadataWaitMs == null) {
    return CONTENT_FIRST_OWNER_SELECTION;
  }
  return { mode: "titleContains", titleNeedle, deck1MetadataWaitMs };
}

function titleMatchesNeedle(title, titleNeedle) {
  const normalizedTitle = normalizedNfcString(title);
  return Boolean(normalizedTitle && normalizedTitle.includes(titleNeedle));
}

function fallbackWireIdentity(candidate) {
  const title = normalizedNfcString(candidate?.title);
  const artist = normalizedNfcString(candidate?.artist);
  if (title && artist) {
    return { title: candidate.title, artist: candidate.artist };
  }
  return typeof candidate?.contentId === "string" && candidate.contentId.length > 0
    ? { contentId: candidate.contentId }
    : null;
}

function textWireIdentity(candidate) {
  const title = normalizedNfcString(candidate?.title);
  const artist = normalizedNfcString(candidate?.artist);
  return title && artist ? { title: candidate.title, artist: candidate.artist } : null;
}

function productionFallbackReevaluationDelayMs(candidates, policyInput) {
  const policy = normalizeOwnerSelectionPolicy(policyInput);
  if (policy.mode !== "titleContains") return null;
  const fresh = Array.isArray(candidates)
    ? candidates.filter((candidate) => candidate && candidate.fresh === true && candidate.isPlaying === true)
    : [];
  const hasPositive = fresh.some((candidate) => titleMatchesNeedle(candidate.title, policy.titleNeedle));
  const deck1 = fresh.find((candidate) => Number(candidate.deck) === 1);
  if (hasPositive || !deck1 || !fallbackWireIdentity(deck1)) return null;
  const sessionAgeMs = finiteNonNegativeInteger(deck1.sessionAgeMs);
  if (sessionAgeMs == null || sessionAgeMs >= policy.deck1MetadataWaitMs) return null;
  return policy.deck1MetadataWaitMs - sessionAgeMs;
}

// `candidates` are already constrained by the detector to a fresh, actually
// playing session. This helper deliberately knows nothing about MASTER: show
// ownership is determined only by the configured production selector.
function selectProductionOwnerCandidate(candidates, policyInput) {
  const policy = normalizeOwnerSelectionPolicy(policyInput);
  if (policy.mode !== "titleContains") return null;

  const fresh = Array.isArray(candidates)
    ? candidates.filter((candidate) => candidate && candidate.fresh === true && candidate.isPlaying === true)
    : [];
  const positive = fresh
    .filter((candidate) => titleMatchesNeedle(candidate.title, policy.titleNeedle))
    .sort((left, right) => Number(left.deck) - Number(right.deck));

  if (positive.length === 1) {
    const selected = positive[0];
    // The selector ignores artist, but v3 text identity must retain both
    // fields. Do not let Deck 2 overtake a matching Deck 1 while this identity
    // is still arriving.
    if (!normalizedNfcString(selected.artist)) {
      return { kind: "wait-for-text-identity", deck: selected.deck };
    }
    return {
      kind: "text",
      deck: selected.deck,
      wireIdentity: { title: selected.title, artist: selected.artist },
    };
  }

  const deck1 = fresh.find((candidate) => Number(candidate.deck) === 1);
  if (positive.length > 1) {
    // Simultaneous positive title matches are intentionally resolved to the
    // physically predictable Deck 1 whenever it is fresh and playing, even
    // when Deck 1 itself is not one of the matching titles. This is the
    // operator-selected ambiguity rule; if Deck 1 is unavailable, retain the
    // deterministic lowest matching positive rather than guessing another.
    if (deck1) {
      // A matching title is only transport-valid as v3 text once artist has
      // arrived. ContentId cannot bypass that prerequisite: it would make the
      // title-based choice unverifiable to the peer.
      const wireIdentity = titleMatchesNeedle(deck1.title, policy.titleNeedle)
        ? textWireIdentity(deck1)
        : fallbackWireIdentity(deck1);
      if (wireIdentity) {
        return { kind: "deck1-ambiguity-fallback", deck: deck1.deck, wireIdentity };
      }
    }
    // Deck 1's ambiguity priority never promotes an identity-incomplete
    // session. When it is unavailable for transport, choose the lowest deck
    // that has the required v3 text identity; do not substitute a matching
    // title's contentId before its artist arrives.
    const selected = positive.find((candidate) => textWireIdentity(candidate));
    if (!selected) {
      return { kind: "wait-for-text-identity", deck: positive[0].deck };
    }
    return {
      kind: "text",
      deck: selected.deck,
      wireIdentity: textWireIdentity(selected),
    };
  }

  // With no title match, a deliberately bounded Deck 1 fallback makes a
  // temporary/non-production track testable without weakening stale or
  // stopped playback gates. Prefer complete text identity; contentId remains
  // the strict identity only while text is unavailable.
  if (
    deck1 &&
    finiteNonNegativeInteger(deck1.sessionAgeMs) != null &&
    deck1.sessionAgeMs >= policy.deck1MetadataWaitMs
  ) {
    const wireIdentity = fallbackWireIdentity(deck1);
    if (wireIdentity) {
      return { kind: "deck1-fallback", deck: deck1.deck, wireIdentity };
    }
  }
  return null;
}

module.exports = {
  CONTENT_FIRST_OWNER_SELECTION,
  normalizeOwnerSelectionPolicy,
  selectProductionOwnerCandidate,
  titleMatchesNeedle,
  fallbackWireIdentity,
  textWireIdentity,
  productionFallbackReevaluationDelayMs,
};
