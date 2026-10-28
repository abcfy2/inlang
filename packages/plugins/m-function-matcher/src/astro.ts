/**
 * The code that can reference messages in an Astro file, extracted as text
 * segments at their original offsets. Astro's own compiler is a Go-WASM
 * binary that cannot be shipped inside a plugin bundle, so the template is
 * delimited by a scanner instead: frontmatter and `<script>` contents
 * verbatim, `{…}` expressions by brace matching that tracks quoting,
 * template literals and comments. Anything the scanner cannot confidently
 * delimit makes the extraction fail so the analysis stays incomplete.
 */
export type AstroSegment = {
	code: string;
	original: number;
	offsets?: { generated: number; original: number }[];
};
type AstroEdit = { start: number; end: number; code: string };
export type AstroFailure = { reason: string; start: number; end: number };
export type AstroExtraction = {
	/** Verbatim program text: the frontmatter and each inline script. */
	segments: AstroSegment[];
	/** The contents of `{…}` expressions, without the braces. */
	expressions: AstroSegment[];
	/** Constructs that withhold the analysis, at their original position. */
	failures: AstroFailure[];
	/** Malformed input; the file's usage analysis cannot proceed. */
	error?: string;
};

const isSpace = (c: string | undefined) =>
	c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

/** The index of the `}` matching `content[open]`, or undefined at the end of input. */
function findExpressionEnd(
	content: string,
	open: number,
	failures: AstroFailure[],
	edits?: AstroEdit[],
): number | undefined {
	let depth = 0;
	let i = open;
	while (i < content.length) {
		const c = content[i];
		if (c === "'" || c === '"') {
			const end = skipQuoted(content, i);
			if (end === undefined) return undefined;
			i = end;
			continue;
		}
		if (c === "`") {
			const end = skipTemplate(content, i, failures, edits);
			if (end === undefined) return undefined;
			i = end;
			continue;
		}
		if (c === "/" && content[i + 1] === "/") {
			const newline = content.indexOf("\n", i);
			if (newline === -1) return undefined;
			i = newline + 1;
			continue;
		}
		if (c === "/" && content[i + 1] === "*") {
			const close = content.indexOf("*/", i + 2);
			if (close === -1) return undefined;
			i = close + 2;
			continue;
		}
		if (c === "<" && /[a-zA-Z>]/.test(content[i + 1] ?? "")) {
			let before = i - 1;
			while (before > open && isSpace(content[before])) before--;
			if (before === open || /[([{=,:?!;&|>]/.test(content[before]!)) {
				const count = edits?.length ?? 0;
				const end = skipElement(content, i, failures, edits);
				if (end !== undefined) {
					i = end;
					continue;
				}
				if (edits) edits.length = count;
			}
		}
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return i;
		}
		i++;
	}
	return undefined;
}

/** The index after the closing quote of the string at `start`. */
function skipQuoted(content: string, start: number): number | undefined {
	const quote = content[start]!;
	for (let i = start + 1; i < content.length; i++) {
		if (content[i] === "\\") i++;
		else if (content[i] === quote) return i + 1;
	}
	return undefined;
}

/** The index after the closing backtick, interpolations included. */
function skipTemplate(
	content: string,
	start: number,
	failures: AstroFailure[],
	edits?: AstroEdit[],
): number | undefined {
	for (let i = start + 1; i < content.length; i++) {
		const c = content[i];
		if (c === "\\") i++;
		else if (c === "`") return i + 1;
		else if (c === "$" && content[i + 1] === "{") {
			const close = findExpressionEnd(content, i + 1, failures, edits);
			if (close === undefined) return undefined;
			i = close;
		}
	}
	return undefined;
}

/** Normalizes Astro-only markup inside an expression without losing source positions. */
function skipElement(
	content: string,
	start: number,
	failures: AstroFailure[],
	edits?: AstroEdit[],
): number | undefined {
	let i = start + 1;
	while (/[a-zA-Z0-9_.:-]/.test(content[i] ?? "")) i++;
	if (content.slice(start + 1, i).toLowerCase() === "script")
		failures.push({
			reason: "Nested Astro scripts cannot be analyzed.",
			start,
			end: i,
		});
	while (i < content.length && content[i] !== ">") {
		if (isSpace(content[i])) {
			i++;
			continue;
		}
		if (content.startsWith("/>", i)) return i + 2;
		if (content[i] === "{") {
			let value = i + 1;
			while (isSpace(content[value])) value++;
			if (!content.startsWith("...", value))
				edits?.push({ start: i + 1, end: i + 1, code: "..." });
			const end = findExpressionEnd(content, i, failures, edits);
			if (end === undefined) return undefined;
			i = end + 1;
			continue;
		}
		const attrStart = i;
		while (i < content.length && !/[\s=/>]/.test(content[i]!)) i++;
		if (i === attrStart) return undefined;
		while (isSpace(content[i])) i++;
		if (content[i] !== "=") continue;
		i++;
		while (isSpace(content[i])) i++;
		const value = content[i];
		if (value === "{") {
			const end = findExpressionEnd(content, i, failures, edits);
			if (end === undefined) return undefined;
			i = end + 1;
		} else if (value === "'" || value === '"') {
			const end = content.indexOf(value, i + 1);
			if (end === -1) return undefined;
			i = end + 1;
		} else if (value === "`") {
			edits?.push({ start: i, end: i, code: "{" });
			const end = skipTemplate(content, i, failures, edits);
			if (end === undefined) return undefined;
			edits?.push({ start: end, end, code: "}" });
			i = end;
		} else {
			edits?.push({ start: i, end: i, code: '"' });
			while (
				i < content.length &&
				!isSpace(content[i]) &&
				content[i] !== ">" &&
				!content.startsWith("/>", i)
			)
				i++;
			edits?.push({ start: i, end: i, code: '"' });
		}
	}
	if (content[i] !== ">") return undefined;
	i++;
	while (i < content.length) {
		if (content.startsWith("<!--", i)) {
			const close = content.indexOf("-->", i + 4);
			if (close === -1) return undefined;
			const end = close + 3;
			edits?.push({
				start: i,
				end,
				code: content.slice(i, end).replace(/[^\r\n]/g, " "),
			});
			i = end;
		} else if (content.startsWith("</", i)) {
			const close = content.indexOf(">", i + 2);
			return close === -1 ? undefined : close + 1;
		} else if (content[i] === "<" && /[a-zA-Z>]/.test(content[i + 1] ?? "")) {
			const end = skipElement(content, i, failures, edits);
			if (end === undefined) return undefined;
			i = end;
		} else if (content[i] === "{") {
			const end = findExpressionEnd(content, i, failures, edits);
			if (end === undefined) return undefined;
			i = end + 1;
		} else {
			i++;
		}
	}
	return undefined;
}

function expressionSegment(
	content: string,
	start: number,
	end: number,
	edits: AstroEdit[],
): AstroSegment {
	if (edits.length === 0)
		return { code: content.slice(start, end), original: start };
	const chunks: string[] = [];
	const offsets: NonNullable<AstroSegment["offsets"]> = [];
	let cursor = start;
	let added = 0;
	for (const edit of edits) {
		chunks.push(content.slice(cursor, edit.start), edit.code);
		added += edit.code.length - (edit.end - edit.start);
		if (edit.start === edit.end)
			offsets.push({
				generated: edit.end - start + added,
				original: edit.end - start,
			});
		cursor = edit.end;
	}
	chunks.push(content.slice(cursor, end));
	return { code: chunks.join(""), original: start, offsets };
}

/** The next `/</name/i` match at or after `from`, like `</script`. */
function closingTag(
	content: string,
	name: string,
	from: number
): number | undefined {
	const pattern = new RegExp(`</${name}`, "gi");
	pattern.lastIndex = from;
	return pattern.exec(content)?.index;
}

export function extractAstro(content: string): AstroExtraction {
	const segments: AstroSegment[] = [];
	const expressions: AstroSegment[] = [];
	const failures: AstroFailure[] = [];
	const fail = (error: string): AstroExtraction => ({
		segments,
		expressions,
		failures,
		error,
	});
	/** Collects the `{…}` expression at `at` and returns the index after it. */
	const collectExpression = (at: number): number | undefined => {
		const edits: AstroEdit[] = [];
		const close = findExpressionEnd(content, at, failures, edits);
		if (close === undefined) return undefined;
		expressions.push(expressionSegment(content, at + 1, close, edits));
		return close + 1;
	};
	let i = 0;
	if (/^---[ \t]*(?:\r?\n|$)/.test(content)) {
		const firstLineEnd = content.indexOf("\n");
		const openEnd = firstLineEnd === -1 ? content.length : firstLineEnd + 1;
		let lineStart = openEnd;
		let close: number | undefined;
		for (;;) {
			const newline = content.indexOf("\n", lineStart);
			const end = newline === -1 ? content.length : newline;
			const line = content.slice(lineStart, end).replace(/\r$/, "");
			if (/^---[ \t]*$/.test(line)) {
				close = lineStart;
				break;
			}
			if (newline === -1) break;
			lineStart = newline + 1;
		}
		if (close === undefined) return fail("unterminated frontmatter fence");
		segments.push({ code: content.slice(openEnd, close), original: openEnd });
		const lastLineEnd = content.indexOf("\n", close);
		i = lastLineEnd === -1 ? content.length : lastLineEnd + 1;
	}
	while (i < content.length) {
		const c = content[i]!;
		if (c !== "<" && c !== "{") {
			i++;
			continue;
		}
		if (c === "{") {
			const next = collectExpression(i);
			if (next === undefined) return fail("unterminated expression");
			i = next;
			continue;
		}
		if (content.startsWith("<!--", i)) {
			const close = content.indexOf("-->", i + 4);
			if (close === -1) return fail("unterminated HTML comment");
			i = close + 3;
			continue;
		}
		if (content[i + 1] === "/") {
			const close = content.indexOf(">", i);
			if (close === -1) return fail("unterminated closing tag");
			i = close + 1;
			continue;
		}
		if (!/[a-zA-Z]/.test(content[i + 1] ?? "")) {
			i++;
			continue;
		}
		let nameEnd = i + 1;
		while (nameEnd < content.length) {
			const nc = content[nameEnd]!;
			if (
				isSpace(nc) ||
				nc === "=" ||
				nc === ">" ||
				(nc === "/" && content[nameEnd + 1] === ">")
			)
				break;
			nameEnd++;
		}
		const name = content.slice(i + 1, nameEnd);
		let k = nameEnd;
		let selfClosed = false;
		let external = false;
		while (k < content.length) {
			while (k < content.length && isSpace(content[k])) k++;
			const ac = content[k];
			if (ac === undefined) return fail("unterminated tag");
			if (ac === ">") {
				k++;
				break;
			}
			if (ac === "/" && content[k + 1] === ">") {
				k += 2;
				selfClosed = true;
				break;
			}
			if (ac === "{") {
				const next = collectExpression(k);
				if (next === undefined) return fail("unterminated expression");
				k = next;
				continue;
			}
			const attrStart = k;
			while (k < content.length) {
				const nc = content[k]!;
				if (
					isSpace(nc) ||
					nc === "=" ||
					nc === ">" ||
					(nc === "/" && content[k + 1] === ">")
				)
					break;
				k++;
			}
			if (k === attrStart) {
				k++;
				continue;
			}
			const attrName = content.slice(attrStart, k);
			if (attrName === "src" && name.toLowerCase() === "script")
				external = true;
			let value = k;
			while (value < content.length && isSpace(content[value])) value++;
			if (content[value] !== "=") {
				k = value;
				continue;
			}
			value++;
			while (value < content.length && isSpace(content[value])) value++;
			const vc = content[value];
			if (vc === '"' || vc === "'") {
				const closeQ = content.indexOf(vc, value + 1);
				if (closeQ === -1) return fail("unterminated attribute value");
				k = closeQ + 1;
			} else if (vc === "`") {
				const edits: AstroEdit[] = [];
				const end = skipTemplate(content, value, failures, edits);
				if (end === undefined) return fail("unterminated attribute value");
				expressions.push(expressionSegment(content, value, end, edits));
				k = end;
			} else if (vc === "{") {
				const next = collectExpression(value);
				if (next === undefined) return fail("unterminated expression");
				k = next;
			} else {
				while (
					value < content.length &&
					!isSpace(content[value]) &&
					content[value] !== ">"
				)
					value++;
				k = value;
			}
		}
		if (
			k >= content.length &&
			!selfClosed &&
			content[content.length - 1] !== ">"
		)
			return fail("unterminated tag");
		if (name.includes(".")) {
			expressions.push({ code: name, original: i + 1 });
			i = k;
			continue;
		}
		const lower = name.toLowerCase();
		if (lower === "style" && !selfClosed) {
			const close = closingTag(content, "style", k);
			if (close === undefined) return fail("unterminated <style> block");
			const end = content.indexOf(">", close);
			if (end === -1) return fail("unterminated <style> block");
			i = end + 1;
			continue;
		}
		if (lower === "script" && external) {
			failures.push({
				reason: "External Astro scripts cannot be analyzed.",
				start: i,
				end: k,
			});
			i = k;
			continue;
		}
		if (lower === "script" && !selfClosed) {
			const close = closingTag(content, "script", k);
			if (close === undefined) return fail("unterminated <script> block");
			const end = content.indexOf(">", close);
			if (end === -1) return fail("unterminated <script> block");
			segments.push({ code: content.slice(k, close), original: k });
			i = end + 1;
			continue;
		}
		i = k;
	}
	return { segments, expressions, failures };
}
