import { readFileSync } from "node:fs";
import { type CollectionTag, parse, type ScalarTag } from "yaml";

// Parses a CloudFormation or SAM template. Plain YAML loaders reject the short-form intrinsic
// functions (!Ref, !Sub, !GetAtt, ...), so each tag is mapped to its long JSON form, for example
// `!Ref GitSha` becomes { Ref: "GitSha" } and `!GetAtt Role.Arn` becomes
// { "Fn::GetAtt": ["Role", "Arn"] }. Tests then compare against the same shapes CloudFormation uses.

type Intrinsic = { [key: string]: unknown };

const FUNCTIONS = [
  "And",
  "Base64",
  "Cidr",
  "Equals",
  "FindInMap",
  "GetAZs",
  "If",
  "ImportValue",
  "Join",
  "Not",
  "Or",
  "Select",
  "Split",
  "Sub",
  "Transform",
] as const;

function longName(name: string): string {
  return `Fn::${name}`;
}

function scalarTag(tag: string, resolve: (value: string) => Intrinsic): ScalarTag {
  return { tag, resolve };
}

function seqTag(tag: string, key: string): CollectionTag {
  return {
    tag,
    collection: "seq",
    resolve: (value) => ({ [key]: value.toJSON() }),
  };
}

function mapTag(tag: string, key: string): CollectionTag {
  return {
    tag,
    collection: "map",
    resolve: (value) => ({ [key]: value.toJSON() }),
  };
}

// Decision: register every short form in scalar, sequence and mapping shape. A template that uses
// a shape CloudFormation rejects still parses here; cfn-lint (sam validate --lint) catches that.
function buildTags(): Array<ScalarTag | CollectionTag> {
  const tags: Array<ScalarTag | CollectionTag> = [
    scalarTag("!Ref", (value) => ({ Ref: value })),
    scalarTag("!Condition", (value) => ({ Condition: value })),
    scalarTag("!GetAtt", (value) => ({ "Fn::GetAtt": value.split(".") })),
    seqTag("!GetAtt", "Fn::GetAtt"),
  ];
  for (const name of FUNCTIONS) {
    const tag = `!${name}`;
    tags.push(scalarTag(tag, (value) => ({ [longName(name)]: value })));
    tags.push(seqTag(tag, longName(name)));
    tags.push(mapTag(tag, longName(name)));
  }
  return tags;
}

export type Template = {
  Parameters: Record<string, { Default?: unknown; AllowedPattern?: string; Type: string }>;
  Resources: Record<string, { Type: string; Properties: Record<string, unknown> }>;
  Outputs: Record<string, { Value: unknown }>;
  Conditions?: Record<string, unknown>;
};

export function parseTemplate(text: string): Template {
  return parse(text, { customTags: buildTags() }) as Template;
}

export function loadTemplate(path: string): Template {
  return parseTemplate(readFileSync(path, "utf8"));
}
