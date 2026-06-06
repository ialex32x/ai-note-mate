/** @type {import('stylelint').Config} */
export default {
  extends: ['stylelint-config-recommended'],
  customSyntax: 'postcss-less',
  rules: {
    'declaration-block-no-duplicate-properties': true,

    // Less variables (@spacing-lg etc.) are not parseable as CSS values
    'declaration-property-value-no-unknown': null,

    // break-word is intentionally used as a progressive enhancement;
    // migrating to overflow-wrap would be a separate, low-priority task
    'declaration-property-value-keyword-no-deprecated': null,

    // Less variables in media queries (@breakpoint-mobile etc.) are not parseable
    'media-query-no-invalid': null,

    // Less nesting routinely triggers false positives for this rule
    'no-descending-specificity': null,

    // clip is used intentionally for screen-reader-only text;
    // replacing with clip-path would be a separate task
    'property-no-deprecated': null,
  },
};
