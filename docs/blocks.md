# Block syntax

Every block Yariche shows is written as plain Markdown that Obsidian can read. A note opened
and saved without changes stays identical byte for byte.

## Headings

`#` to `####`. Heading 4 appears in the table of contents.

## Callouts and toggle blocks

```markdown
> [!note] Title
> Body

> [!warning]- Folded by default
> Hidden until opened

> [!toggle]- Toggle block
> Content under the toggle
```

A `-` after the type folds the callout, a `+` keeps it open, like Obsidian. Opening or closing
a block in Yariche is local to your screen: the file does not change. `[!toggle]` is shown
without a coloured box, as a toggle block.

## Columns

```markdown
> [!columns]
>
> > [!column|40]
> > Left column
>
> > [!column|60]
> > Right column
```

The number after `|` is the width share of the column. Shares are normalised on display, so
`|1` and `|3` give a quarter and three quarters. Without a number, columns are equal. Drag the
gap between two columns to resize them (steps of 1/8 of the column count); double-click it to
make them equal again. On a phone, columns are stacked. In Obsidian the same text shows as
nested callouts.

## Equations

```markdown
Inline: $E = mc^2$

$$
\sum_{i=1}^n x_i
$$
```

Rendered with KaTeX. As in Obsidian, `$` followed by a space or a digit after the closing `$`
is not an equation, so prices such as `5 $` or `$5 and $10` stay text. Type `$…$` to create an
inline equation, or `$$` and a space on an empty line for a block. Click an equation to edit it.

## Bookmarks

````markdown
```embed
title: "Page title"
image: "https://example.com/cover.png"
description: "Summary"
url: "https://example.com/page"
favicon: "https://example.com/favicon.ico"
```
````

This is the format of the Obsidian "Link Embed" plugin. The server fetches the preview
(`/api/unfurl`) when the bookmark is created. It refuses private, local and reserved
addresses, including after a redirect, and only uses ports 80, 443, 8080 and 8443. Preview
images go through the server (`/api/unfurl/image`): the browser never contacts the site.

## Attachments

```markdown
![[attachments/report-20261018-101500.docx]]
```

Any file up to 25 MB can be attached (`/` then "Fichier", drop or paste). Images and PDF are
shown in the page. Other files appear as a card and are always downloaded, never opened in the
app.

## Database relations and rollups

A relation property links rows to rows of another database, or of the same one. Its value is
a list of row ids in the `.db.json` file. A relation "both ways" keeps a mirror property in the
linked database: when a row is linked on one side, the server adds the link on the other side
(`POST /api/doc/:room/db/relation`), in the open document if someone has it open and always in
the file. Moving or renaming a database updates the relations that point to it.

A rollup shows a property of the linked rows: the values themselves, or a calculation (count,
unique values, empty, sum, average, median, min, max, range, earliest and latest date, date
range, checked, percentages).
