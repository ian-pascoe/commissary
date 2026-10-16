/**
 * `@commissary/translation/testing`: the fixtures and helpers translation shares with its dependants' tests (the
 * Worker's executor and pipeline tests). Only test files may import it (lint rule, docs/DEVELOPMENT.md "Tests").
 */
export { expandEmbeddedJson, structuralBody } from "./support/structural.ts";

export { catalogLookup, fixture as thinkingFixture } from "./support/thinking.ts";

export { itTranslatorFixture, type TranslatorFixtureCase } from "./support/translator-fixtures.ts";

/** The token counting fixtures (`go run ./tools/fixturegen/tokens`). */
export { default as tokenFixtures } from "./fixtures/tokens.json";
