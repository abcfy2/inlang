import { expect, test } from "vitest";
import { analyzeUsage } from "./analyzeUsage.js";
const settings = { baseLocale: "en", locales: ["en"], modules: [] };
const analyze = (content: string) =>
	analyzeUsage({
		files: [{ path: "src/Page.astro", content }],
		settings,
	});

test("analyzes frontmatter, template and attribute expressions", async () => {
	const result = await analyze(`---
import { m } from './messages';
const label = m.frontmatter();
---
<p title={m.attribute()}>{m.template()}</p>`);
	expect(result.status).toBe("complete");
	expect(new Set(result.usedBundleIds)).toEqual(
		new Set(["frontmatter", "attribute", "template"])
	);
});

test("analyzes inline scripts, set:html and define:vars expressions", async () => {
	const result = await analyze(`---
import { m } from './messages';
const label = m.script();
---
<title>Home</title>
<article set:html={m.html()} define:vars={{ title: m.vars() }} />
<script>
import { m as messages } from './messages';
const label = messages.inline();
</script>`);
	expect(result.status).toBe("complete");
	expect(new Set(result.usedBundleIds)).toEqual(
		new Set(["script", "html", "vars", "inline"])
	);
});

test("quoted attribute values, CSS and HTML comments are literal", async () => {
	const result = await analyze(`---
import { m } from './messages';
---
<div title="literal {m.never()}" data-x='m.never()'>
	<!-- {m.commented()} -->
	<p>{m.real()}</p>
</div>
<style>p::after { content: "{m.styled()}"; font-family: m; }</style>`);
	expect(result.status).toBe("complete");
	expect(result.usedBundleIds).toEqual(["real"]);
});

test("tracks strings, template literals, comments and nesting in expressions", async () => {
	const result = await analyze(`---
import { m } from './messages';
---
<p>{m.msg({ text: "a}b" })}</p>
<p>{\`pre \${m.tpl()} post\`}</p>
<p>{
	/* a } comment */
	cond ? { label: m.nested() } : null
}</p>
<p>{m.multi.line({
	count: 1,
 })}</p>`);
	expect(result.status).toBe("complete");
	expect(new Set(result.usedBundleIds)).toEqual(
		new Set(["msg", "tpl", "nested", "multi"])
	);
});

test("analyzes JSX fragments inside template expressions", async () => {
	const result = await analyze(`---
import { m } from './messages';
---
<ul>{items.map((item) => (
	<li title={m.item_title()} key={item.id}>{m.item_label(item.name)}</li>
))}</ul>`);
	expect(result.status).toBe("complete");
	expect(new Set(result.usedBundleIds)).toEqual(
		new Set(["item_title", "item_label"])
	);
});

test("analyzes top-level returns in the frontmatter", async () => {
	const result = await analyze(`---
import { m } from './messages';
if (!Astro.props.ok) {
	return Astro.redirect("/404");
}
---
<p>{m.page()}</p>`);
	expect(result.status).toBe("complete");
	expect(result.usedBundleIds).toEqual(["page"]);
});

test("extracts every inline script and ignores closing tags in attribute strings", async () => {
	const result = await analyze(`---
---
<div title="</style>">first</div>
<style>p { color: red }</style>
<script>
import { m } from './messages';
const a = m.first_script();
</script>
<p>{m.template()}</p>
<script>
import { m } from './messages';
const b = m.second_script();
</script>`);
	expect(result.status).toBe("complete");
	expect(new Set(result.usedBundleIds)).toEqual(
		new Set(["first_script", "second_script", "template"]),
	);
});

test.each([
	`---
import { m } from './messages';
let key;
---
<p>{m[key]()}</p>`,
	`---
import { m } from './messages';
const label = m[\`template_\${key}_label\`]();
---
<p />`,
	`---
import { m } from './messages';
---
<Comp label={m} />`,
	`---
import { m } from './messages';
---
<div {...m} />`,
	`---
import { m } from './messages';
---
<script src="./external.js"></script>`,
	`---
import { m } from './messages';
<p>{m.unterminated(</p>`,
	`---
const label = 'no closing fence';`,
])("unresolved or invalid Astro input withholds fixes: %s", async (code) => {
	expect((await analyze(code)).status).toBe("incomplete");
});

test("locates unresolved constructs in frontmatter and templates", async () => {
	const template = await analyze(`---
import { m } from './messages';
let key;
---
<p>{m[key]()}</p>`);
	expect(template.status).toBe("incomplete");
	expect(template.issues).toEqual([
		{
			path: "src/Page.astro",
			reason: "Dynamic message access cannot be resolved.",
			start: { line: 5, column: 4 },
			end: { line: 5, column: 10 },
		},
	]);
	const external = await analyze(`<script src="./external.js"></script>`);
	expect(external.issues).toEqual([
		{
			path: "src/Page.astro",
			reason: "External Astro scripts cannot be analyzed.",
			start: { line: 1, column: 0 },
			end: { line: 1, column: 28 },
		},
	]);
});
