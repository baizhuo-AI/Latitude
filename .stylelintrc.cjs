module.exports = {
  extends: ["stylelint-config-standard"],
  ignoreFiles: ["dist/**/*", "node_modules/**/*"],
  overrides: [
    {
      files: ["src/styles/tokens.css"],
      rules: {
        "color-hex-length": null,
        "custom-property-empty-line-before": null,
        "declaration-property-value-disallowed-list": null,
        "value-keyword-case": null
      }
    },
    {
      // The Dimension surface is an illustration layer: its paper scraps,
      // constellation geometry and character staging intentionally use exact
      // authored dimensions and colors. Keep syntax/accessibility-adjacent CSS
      // validation, but do not force those art coordinates into product tokens
      // or reject the established BEM modifier names.
      files: ["src/dimension/**/*.css"],
      rules: {
        "alpha-value-notation": null,
        "color-hex-length": null,
        "comment-empty-line-before": null,
        "declaration-block-single-line-max-declarations": null,
        "declaration-property-value-disallowed-list": null,
        "no-descending-specificity": null,
        "no-duplicate-selectors": null,
        "rule-empty-line-before": null,
        "selector-class-pattern": null
      }
    }
  ],
  rules: {
    "alpha-value-notation": "number",
    "at-rule-no-unknown": [
      true,
      {
        ignoreAtRules: ["tailwind", "apply", "layer", "variants", "responsive", "screen"]
      }
    ],
    "import-notation": null,
    "declaration-property-value-disallowed-list": {
      "/color$/": ["/#/", "/rgb\\(/", "/hsl\\(/"],
      "box-shadow": ["/(?!var\\().+/"],
      "/^(margin|padding|gap|row-gap|column-gap|inset|top|right|bottom|left|min-width|min-height|max-width|max-height|width|height)$/": [
        "/^(?!0$|100%$|auto$|inherit$|unset$|initial$|var\\().+/"
      ]
    },
    "custom-property-pattern": "^([a-z0-9]+-)*[a-z0-9]+$",
    "rule-empty-line-before": [
      "always-multi-line",
      {
        except: ["first-nested"],
        ignore: ["after-comment"]
      }
    ]
  }
};
