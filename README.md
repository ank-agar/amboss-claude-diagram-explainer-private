claude-flowchart-maker-idea document

# What I need:
- Doing questions on Amboss is a bit annoying/tricky because I need diagrams to help me understand them/make it simpler for me to understand. That's why I created a Claude Code thread that automatically generates a flow chart diagram in SVG format for any text that I give to it. 
- Right now I've been doing this thing where I have two windows open on my computer. The one on the right is AMBOSS, and the other window is Claude's website, where I paste all of the relevant text from the question into that thread. It then uses the skill to generate that diagram for me.
- However, this process is clunky, and I know that we can probably make it better using some kind of Claude code Chrome extension or some other kind of Claudecode-made tool. 
- Because it takes time for Claude to use the skill to generate the diagram, in an ideal world, I would just go through different Amboss pages. Whenever I wanted to generate a diagram, I just click a button and Claude will start generating the diagram. Then I should be able to just go back to that page, and if we already have a diagram for it, it should just pull it up rather than having to regenerate it or something. 

# Here's context about Amboss so it helps you make the tool:
- When you first go to a question's page, the question does not show that it's answered. The URL also includes the word session.
    - If you answer a question then go to another page, and then come back to this question page where you've already answered the question. I don't think the URL is actually going to indicate that you already answered it. For the case where you've answered a question, then went to another question page, and then came back, we have the folder already-answered-page
    - For the case where you have not answered a question, its folder is called questionpage
    - For the case where you where on a questionpage and then selected an answer, we have the folder called answerpage
- If you finish a session of questions and then go back to the session to review it the url will now say "review" in it. I saved an example of that to the folder called "reviewpage"
- If I do a question during a regular session, the URL would look like this: https://next.amboss.com/us/questions/2WKWaTk2mj/1
    - if I complete the session and come back to the page, then it becomes a review session and the link would be this instead for that same question: https://next.amboss.com/us/review/2WKWaTk2mj/1
    - so you can see that they have that same sort of code in their url (wWKWaTk2mj) which indicates the session ID, and that solo number in the url indicates the question number within the session (which is 1 in this case). So a specific question will always have the same session ID and question number. But both of those links I just gave are for the same question so if we make a diagram, it should be tied to both links.

# Here's my idea for how the extension should work:
- if I'm on an amboss page, and I click on the extension button in the brave/chrome menu bar, it should:
    - copy the text of the question + the attending tip if it is there + the text of the correct answer choice + the explanation of the correct answer choice
    - use those as input for the claudecode skill that we selected which is:
        - [insertskill]
    - that claudecode skill spits out a diagram
    - THIS IS THE PART THAT I'M NOT SURE ABOUT. LET ME KNOW YOUR THOUGHTS ON WHAT'S POSSIBLE
        - maybe the extension should save the diagram and associate it with that question, so that if I go back to it (either in a review session or a regular session), it opens a pane on the right side which shows me the diagram
        - Or maybe we should set the extension so that the diagrams are just in a completely separate window, rather than cluttering up the Amboss screen? I would honestly prefer it if it's in a second window, because then I can use a two-monitor setup where I'm doing Amboss on one window on one device. On my second monitor, it could show the diagram if we've generated one for this page, or it just shows a button to click if I wanted to make a figure and save it for that question. 