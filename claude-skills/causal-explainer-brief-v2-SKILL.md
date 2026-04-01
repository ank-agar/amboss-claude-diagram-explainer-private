---
name: causal-explainer-brief-v2
description: >
  Updated version of causal-explainer-brief with improved diagram layout rules.
  Use for concise Step 1 explanations that pair a short text output with a
  diagram. Adds strict column width limits (200px max), box height formula
  (lines × 20px + 24px), and no-overlap enforcement for branching diagrams.
  Prefer this over causal-explainer-brief for all new diagrams.
---

# Causal Explainer — Brief

Always produce three sections + diagram in this exact order. No extras, no reordering.

1. Main idea
2. Vocabulary
3. Step 1 pearls
4. Diagram

Do NOT wrap any prose in code fences. Code fences are for SVG only.

---

## Section 1 — Main idea

4–6 plain bullets written for a smart high schooler. Genuinely simple — not dumbed-down-but-still-jargon. Use complete sentences in each bullet. Introduce what the thing is, what normally happens, what goes wrong, and why it matters.

Tone: "The placenta is the blob of tissue that feeds the baby" not "The placenta is the organ responsible for fetal nutrition."

No terse medical shorthand. No jargon without explanation. Each bullet should be one thought.

---

## Section 2 — Vocabulary

A flat bullet list defining every term that appears in the diagram that a non-medical reader wouldn't already know. Rules:
- Plain-English definition in one sentence — use concrete language
- If the word has useful etymology (Latin/Greek roots), break it down inline
- Only define terms that actually appear in the diagram. Don't define background context.
- Skip any term the average person already knows (e.g. "heart", "blood", "pain")

Gold standard:
- Spiral arteries: the mom's tiny blood vessels that plug into the back of the placenta to supply it with blood
- DIC (disseminated intravascular coagulation): dis (apart) + seminated (scattered) + intra (inside) + vascular (blood vessels) = the body's clotting system gets triggered everywhere at once, burns through all its clotting factors, and paradoxically causes bleeding from multiple sites
- Myelin: the insulating sheath around nerve fibers, like the plastic coating on a wire

---

## Section 3 — Step 1 pearls

2–4 bullets only. Each bullet = one high-yield testable fact. Bold the single most testable word or phrase per bullet. No paragraphs.

---

## Gold standard output structure

The final output for any topic should look like this (using retroplacental hematoma as the example):

**Section 1 — Main idea**
- The placenta is the blob of tissue inside the uterus that feeds the baby
- A retroplacental hematoma is a blood clot that forms behind the placenta
- This is bad because the clot pushes the placenta off the uterine wall, cutting off the baby's oxygen
- It's also bad for the mom because blood pools silently inside — she can bleed out with very little showing outside

**Section 2 — Vocabulary**
- Uterus: the womb, where the baby grows
- Placenta: the blob of tissue attached to the inside of the uterus that passes oxygen and nutrients from mom's blood to the baby's blood
- Spiral arteries: the mom's tiny blood vessels that plug into the back of the placenta to supply it
- DIC (disseminated intravascular coagulation): the body's clotting system gets triggered everywhere at once, burns through all its clotting factors, and paradoxically causes uncontrolled bleeding

**Section 3 — Step 1 pearls**
- **Painful bleeding = abruption; painless = previa** — most tested distinction in obstetric emergencies
- **Concealed hemorrhage:** mom can be in severe shock with minimal visible bleeding
- **DIC:** fibrinogen falls first — most sensitive early marker
- **#1 risk factor = hypertension/preeclampsia**

**Section 4 — Diagram**
SVG with:
- Title at top: "Retroplacental hematoma (placental abruption)"
- Gray upstream box: "Causes: HTN/preeclampsia · trauma · cocaine · smoking" → feeds into root
- Coral root box: "Retroplacental hematoma: spiral artery ruptures → blood clot forms behind placenta"
- Purple mechanism box: "Clot grows between placenta + uterine wall → placenta peels off the wall"
- Three teal consequence branches fanning out:
  - "Placenta supply cut off → baby starved of O₂" → gray outcome: "Without oxygen, baby's organs start failing → death if not delivered immediately"
  - "Clot stretches uterus → painful contractions" → gray outcome: "Rigid, board-like uterus. Tender on exam."
  - "Blood stays trapped inside → hidden blood loss" → gray outcome with numbered parallel items: "1. Mom loses so much blood her organs start shutting down (none visible outside)  2. DIC: body tries to clot everywhere at once → uses up all clotting factors → uncontrolled bleeding"
- Dashed divider + contrast box at bottom: "vs. placenta previa: painless · soft uterus · visible bleed · no DIC"



The diagram carries ALL the mechanistic content. There is no separate written causal chain — the diagram IS the explanation of what's happening. Make it complete enough to stand alone.

BOX CONTENT SYSTEM:
Each box contains one or two lines of flowing plain-English text — like a caption, not a structured label. Bold the most important word or phrase with <tspan font-weight="500">. All text uses class="ts" (12px).

Write: "Clot crushes placenta → baby starved of O2"
NOT: title "Down Blood to baby" + subtitle "Clot crushes placenta"

Every box must be self-explanatory to someone who just read the vocabulary section. If the box names a clinical outcome (e.g. DIC, shock, fetal distress), always say what it actually means or does in the same box — never just the name alone.

Specific rules:
- "Cut off" always needs a subject — say WHAT is cut off: "placenta blood supply cut off" not "placenta supply cut off"
- "Distress" is too vague — say what's actually happening: "baby not getting enough O₂ → heart rate drops" not "baby in distress"
- "Shock" needs a cause stated: "mom loses too much blood → goes into shock" not just "mom in shock"
- "DIC" always needs what it does: "DIC — clotting system burns out → uncontrolled bleeding" not just "DIC sets in"
- Every pair of lines in a box must have an explicit grammatical connector between them: either → (cause/effect), a colon (definition/elaboration), or a period (two separate complete facts). Never two lines with no relationship signal.

No repeating information in different words within a single box. No previewing what the next box already shows.

NO DUPLICATES BETWEEN BOXES: If box A already states that X happens, the box immediately below it must not restate X — it should only say what X leads to next. Read every parent-child box pair and ask: "does the child repeat anything already said in the parent?" If yes, cut the repeated part from the child.

NEVER USE VAGUE CLINICAL SHORTHAND IN OUTCOME BOXES: Terms like "fetal distress", "shock", "DIC", "heart rate crashes", "hemodynamic instability" mean nothing to someone who doesn't already know them. Every outcome box must say what actually happens to the person in plain English that a high schooler would understand. Ask: "if someone had never taken a biology class, would they understand this box?" If not, rewrite it.

BAD examples (too vague or too terse):
- "fetal distress" → says nothing
- "heart rate crashes" → still jargon
- "Mom in shock" → what does shock mean?
- "DIC = clotting burns out" → is DIC the cause or the definition?

GOOD examples (plain, complete, self-explanatory):
- "baby can't get enough oxygen → brain damage or death if not delivered immediately"
- "1. Mom loses so much blood her organs start shutting down (no visible bleeding outside)"
- "2. DIC: the body tries to clot the bleed everywhere at once, uses up all its clotting factors, then paradoxically starts bleeding uncontrollably from every site"

When numbering parallel items, write each one as a complete plain-English sentence, not a terse label.

PARALLEL ITEMS WITHIN A BOX: When a box contains two or more parallel outcomes (neither causes the other), number them explicitly: "1. ... 2. ..." This makes it unambiguous that they are a list, not a causal sequence.

DIAGRAM TITLE: Always put a plain-text title at the very top of the SVG, above all boxes, that names the condition being explained. Use class="th", centered, y=20.

BOX RELATIONSHIP CLARITY: When a box has two lines, the relationship between them must be visually explicit. Use one of:
- An arrow within the text: "Clot forms → placenta peels off"
- A colon: "Cause: the spiral artery ruptures"
- A period to separate two independent facts: "Uterus goes rigid. Tender on exam."
Never write two lines that just sit next to each other with no connective — the reader cannot tell if line 2 is a cause, effect, definition, or example of line 1.

LIST VS SEQUENCE: When a box contains a list of parallel items (e.g. causes, risk factors), make it visually clear they are a list by writing "Causes: X · Y · Z" or "Risk factors: X · Y · Z" — not just "X · Y · Z" with no label, which looks like a sequence.

CONTRAST BOX: If there's a key differential (e.g. abruption vs previa), it goes as a clearly labeled box at the bottom of the diagram connected with a plain line or a dashed divider, not as a floating text note. Label it explicitly — e.g. "vs. placenta previa" as the box title.

FSH and LH always separate boxes.

ANATOMICAL SOURCE: put location in the box label when it matters — "Up GH (from pituitary)", not a separate container unless cell boundaries are mechanistically important.

TREATMENT COLUMN: dedicated right column, no connection lines. Single-phrase style. Inner horizontal divider. Italic "targets: [step]" below divider.

TEXT OVERFLOW: longest_chars x 7px + 20px <= box_width. Check every box. Root box is highest risk.

COLUMN LAYOUT FOR BRANCHING DIAGRAMS: When fanning out into 3 side-by-side columns, each column must be at most 200px wide with at least 10px gap between columns (3 × 200 + 2 × 10 = 620px, safely within the 680px viewBox). Never try to fit long sentences on a single line inside a narrow column box — instead break text across 3–4 short `<tspan>` lines. Minimum box height for column boxes is 80px; outcome boxes below them should be at least 96px tall. If content requires more lines, increase height further — it is always better to make a box taller than to let text overflow or overlap.

BOX HEIGHT FORMULA: box_height = (number_of_text_lines × 20px) + 24px padding. A box with 4 lines of text needs at least 104px height. Never guess — count the lines and calculate.

NEVER OVERLAP: After placing every box, verify that no box's top edge is less than 10px below the bottom edge of any box above it in the same column. If branches have different heights, use the tallest branch to set the y-position of the next row of boxes.

viewBox: H = bottom of lowest element + 50px. Always 680px wide.

All other diagram rules (arrow routing, overlap checks, pre-layout table, single-origin fan-out, convergence, colors, legend) follow causal-explainer SKILL.md exactly.
