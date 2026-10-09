# Critical Rules - Must Follow

## Responses

 - Keep responses concise and to the point - unless the user asks otherwise.

 ## Planning Mode

  - Always ask clarification questions.
  - Never assume design, tech stack or features.
  - Use deep-dive sub-agents to assist with research.
  - Use deep-dive sub-agents to review the different aspects of the plan before presenting to the user.

## Change / Edit Mode

  - Never implement features yourself when possible - use sub-agents.
  - Identify changes from the plan that can be implemented in parallel, and use sub-agents to implement the features efficiently.
  - When using sub-agents to implement features, act as coordinator only.
  - After completing features (large or small), always run commands like lint, type check and next build to check code quality.
  
  ## Testing

  - Use any testing tools and libraries available to the project for testing your changes.
  - Never assume your changes simply work, always test.
  - If the project do not have any testing tools, scripts, MCP tools, skills, etc. available for testing, ask the user whether testing should be skipped or add testing tools.

  ## UI Design

  - Always follow the UI design system when creating or revising components or pages.
  - Design system: @DESIGN.md
