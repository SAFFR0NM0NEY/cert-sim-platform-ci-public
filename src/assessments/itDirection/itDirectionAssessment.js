export const IT_DIRECTION_PATHWAYS = [
  {
    id: 'softwareDevelopment',
    name: 'Software Development',
    shortName: 'Software',
    description:
      'Coding, apps, websites, automation, logic, and turning ideas into working tools.',
    courseDirection:
      'Start with programming fundamentals, web development basics, and small automation projects.',
    discussionPrompts: [
      'Ask whether the student enjoys building things from instructions, examples, or their own ideas.',
      'Discuss whether they prefer visual interfaces, automation scripts, websites, or backend logic.',
    ],
  },
  {
    id: 'cybersecurity',
    name: 'Cybersecurity',
    shortName: 'Security',
    description:
      'Protection, investigation, risk, safe systems, attacks, defence, and evidence-based thinking.',
    courseDirection:
      'Start with IT fundamentals, networking basics, security awareness, and Security+ style concepts.',
    discussionPrompts: [
      'Ask whether the student enjoys careful investigation, rules, risk, and evidence-based decisions.',
      'Discuss the importance of patience, ethics, and strong fundamentals before specialising.',
    ],
  },
  {
    id: 'cloudDevops',
    name: 'Cloud / DevOps',
    shortName: 'Cloud',
    description:
      'Cloud platforms, deployment, automation, monitoring, reliability, and modern service delivery.',
    courseDirection:
      'Start with cloud fundamentals, Linux/PowerShell basics, Git, and deployment pipeline concepts.',
    discussionPrompts: [
      'Ask whether the student likes automation, deployments, monitoring, and keeping systems reliable.',
      'Discuss whether they are comfortable learning command-line basics and cloud concepts together.',
    ],
  },
  {
    id: 'networkingInfrastructure',
    name: 'Networking / Infrastructure',
    shortName: 'Networking',
    description:
      'Connectivity, routing, switching, servers, infrastructure planning, and keeping systems reachable.',
    courseDirection:
      'Start with hardware, TCP/IP, network troubleshooting, routing, switching, and server basics.',
    discussionPrompts: [
      'Ask whether the student enjoys understanding how devices connect and why systems go offline.',
      'Discuss practical troubleshooting, cabling, addressing, Wi-Fi, and server fundamentals.',
    ],
  },
  {
    id: 'itSupportOperations',
    name: 'IT Support / Operations',
    shortName: 'Support',
    description:
      'Troubleshooting, users, devices, helpdesk workflows, daily technical support, and practical fixes.',
    courseDirection:
      'Start with computer fundamentals, operating systems, troubleshooting method, and helpdesk practice.',
    discussionPrompts: [
      'Ask whether the student is comfortable helping people and solving varied daily problems.',
      'Discuss communication, ticket notes, troubleshooting steps, and customer-facing practice.',
    ],
  },
  {
    id: 'dataAi',
    name: 'Data / AI',
    shortName: 'Data',
    description:
      'Data, patterns, reports, automation, AI tools, insights, and turning information into decisions.',
    courseDirection:
      'Start with spreadsheets, databases, basic Python or SQL, reporting, and responsible AI tool use.',
    discussionPrompts: [
      'Ask whether the student enjoys patterns, reports, dashboards, and making messy information clearer.',
      'Discuss spreadsheet confidence, basic database ideas, and responsible use of AI tools.',
    ],
  },
  {
    id: 'businessIt',
    name: 'Business IT / Office Administration',
    shortName: 'Business IT',
    description:
      'Productivity systems, client-facing operations, business process support, documentation, and admin tools.',
    courseDirection:
      'Start with Microsoft 365, business systems, digital administration, reporting, and workflow improvement.',
    discussionPrompts: [
      'Ask whether the student enjoys organising information, supporting business processes, and working with clients.',
      'Discuss Microsoft 365, digital administration, documentation, and workflow improvement.',
    ],
  },
];

export const itDirectionAssessment = {
  id: 'it-direction-assessment',
  title: 'IT Direction Assessment',
  subtitle:
    'A short guidance tool for matching a person to practical IT study directions.',
  guidanceNote:
    'This is not a pass/fail test. It is a conversation starter for choosing a sensible first study direction.',
  receptionNote:
    'Reception can use this result as a conversation starter before advising on study options.',
  resultDisclaimer:
    'This assessment is guidance only. It is not a final career decision, a certification result, or a guarantee of success in any course or job path.',
  pathways: IT_DIRECTION_PATHWAYS,
  items: [
    {
      id: 'itdir-interest-001',
      dimension: 'interest',
      prompt: 'Which task sounds most interesting to you?',
      options: [
        {
          id: 'a',
          text: 'Build a small app that helps people complete a task faster.',
          scores: { softwareDevelopment: 3, dataAi: 1 },
        },
        {
          id: 'b',
          text: 'Investigate why someone received a suspicious email.',
          scores: { cybersecurity: 3, itSupportOperations: 1 },
        },
        {
          id: 'c',
          text: 'Connect computers and services so people can work reliably.',
          scores: { networkingInfrastructure: 3, cloudDevops: 1 },
        },
        {
          id: 'd',
          text: 'Organise documents, spreadsheets, and office systems for a team.',
          scores: { businessIt: 3, dataAi: 1 },
        },
      ],
    },
    {
      id: 'itdir-interest-002',
      dimension: 'interest',
      prompt: 'Which problem would you rather solve first?',
      options: [
        {
          id: 'a',
          text: 'A website form is not saving customer details correctly.',
          scores: { softwareDevelopment: 3, businessIt: 1 },
        },
        {
          id: 'b',
          text: 'A user cannot connect to the company Wi-Fi.',
          scores: { networkingInfrastructure: 2, itSupportOperations: 2 },
        },
        {
          id: 'c',
          text: 'A server must be moved to a cloud platform safely.',
          scores: { cloudDevops: 3, networkingInfrastructure: 1 },
        },
        {
          id: 'd',
          text: 'A report has too much raw data and needs a clear summary.',
          scores: { dataAi: 3, businessIt: 1 },
        },
      ],
    },
    {
      id: 'itdir-interest-003',
      dimension: 'interest',
      prompt: 'Which project would you choose first?',
      options: [
        {
          id: 'a',
          text: 'Create a simple booking system for a small business.',
          scores: { softwareDevelopment: 3, businessIt: 1 },
        },
        {
          id: 'b',
          text: 'Design a safer login process for staff.',
          scores: { cybersecurity: 3, businessIt: 1 },
        },
        {
          id: 'c',
          text: 'Automate a deployment so updates reach users faster.',
          scores: { cloudDevops: 3, softwareDevelopment: 1 },
        },
        {
          id: 'd',
          text: 'Set up a small office network with printers and shared devices.',
          scores: { networkingInfrastructure: 3, itSupportOperations: 1 },
        },
      ],
    },
    {
      id: 'itdir-interest-004',
      dimension: 'interest',
      prompt: 'Which working style feels most natural to you?',
      options: [
        {
          id: 'a',
          text: 'Quietly working through logic until the solution behaves correctly.',
          scores: { softwareDevelopment: 3, dataAi: 1 },
        },
        {
          id: 'b',
          text: 'Following clues and evidence to find what went wrong.',
          scores: { cybersecurity: 2, itSupportOperations: 2 },
        },
        {
          id: 'c',
          text: 'Keeping systems stable and improving them step by step.',
          scores: { cloudDevops: 2, networkingInfrastructure: 2 },
        },
        {
          id: 'd',
          text: 'Helping people use tools properly and documenting processes.',
          scores: { businessIt: 2, itSupportOperations: 2 },
        },
      ],
    },
    {
      id: 'itdir-interest-005',
      dimension: 'interest',
      prompt: 'Which type of learning content would you watch first?',
      options: [
        {
          id: 'a',
          text: 'How to code a useful script from scratch.',
          scores: { softwareDevelopment: 3, cloudDevops: 1 },
        },
        {
          id: 'b',
          text: 'How hackers trick users and how to reduce the risk.',
          scores: { cybersecurity: 3, businessIt: 1 },
        },
        {
          id: 'c',
          text: 'How data becomes charts, dashboards, and insights.',
          scores: { dataAi: 3, businessIt: 1 },
        },
        {
          id: 'd',
          text: 'How computers, routers, and servers communicate.',
          scores: { networkingInfrastructure: 3, itSupportOperations: 1 },
        },
      ],
    },
    {
      id: 'itdir-interest-006',
      dimension: 'interest',
      prompt: 'Which team role sounds like a good fit?',
      options: [
        {
          id: 'a',
          text: 'The person who builds the tool.',
          scores: { softwareDevelopment: 3, cloudDevops: 1 },
        },
        {
          id: 'b',
          text: 'The person who checks whether the tool is safe.',
          scores: { cybersecurity: 3, cloudDevops: 1 },
        },
        {
          id: 'c',
          text: 'The person who keeps users working when something breaks.',
          scores: { itSupportOperations: 3, businessIt: 1 },
        },
        {
          id: 'd',
          text: 'The person who turns activity into clear reports.',
          scores: { dataAi: 3, businessIt: 1 },
        },
      ],
    },
    {
      id: 'itdir-interest-007',
      dimension: 'interest',
      prompt: 'Which environment sounds most appealing?',
      options: [
        {
          id: 'a',
          text: 'A development team building websites, apps, and internal tools.',
          scores: { softwareDevelopment: 3, cloudDevops: 1 },
        },
        {
          id: 'b',
          text: 'A security team reviewing alerts, risks, and suspicious activity.',
          scores: { cybersecurity: 3, networkingInfrastructure: 1 },
        },
        {
          id: 'c',
          text: 'A support desk solving varied user and device issues every day.',
          scores: { itSupportOperations: 3, businessIt: 1 },
        },
        {
          id: 'd',
          text: 'An office operations team improving forms, files, and workflows.',
          scores: { businessIt: 3, dataAi: 1 },
        },
      ],
    },
    {
      id: 'itdir-interest-008',
      dimension: 'interest',
      prompt: 'Which challenge sounds satisfying?',
      options: [
        {
          id: 'a',
          text: 'Making a slow manual task happen automatically.',
          scores: { softwareDevelopment: 2, cloudDevops: 2 },
        },
        {
          id: 'b',
          text: 'Finding the weak point before it becomes a serious problem.',
          scores: { cybersecurity: 3, networkingInfrastructure: 1 },
        },
        {
          id: 'c',
          text: 'Making sure people can connect to the right resources.',
          scores: { networkingInfrastructure: 2, itSupportOperations: 2 },
        },
        {
          id: 'd',
          text: 'Turning messy information into something a manager can use.',
          scores: { dataAi: 2, businessIt: 2 },
        },
      ],
    },
    {
      id: 'itdir-interest-009',
      dimension: 'interest',
      prompt: 'Which phrase feels closest to you?',
      options: [
        {
          id: 'a',
          text: 'I like understanding how things are built.',
          scores: { softwareDevelopment: 2, cloudDevops: 1, networkingInfrastructure: 1 },
        },
        {
          id: 'b',
          text: 'I like spotting what could go wrong.',
          scores: { cybersecurity: 3, itSupportOperations: 1 },
        },
        {
          id: 'c',
          text: 'I like helping people get unstuck.',
          scores: { itSupportOperations: 3, businessIt: 1 },
        },
        {
          id: 'd',
          text: 'I like finding patterns in information.',
          scores: { dataAi: 3, softwareDevelopment: 1 },
        },
      ],
    },
    {
      id: 'itdir-interest-010',
      dimension: 'interest',
      prompt: 'A friend asks you for help with technology. What would you prefer to do?',
      options: [
        {
          id: 'a',
          text: 'Fix the device, account, or app issue directly.',
          scores: { itSupportOperations: 3, businessIt: 1 },
        },
        {
          id: 'b',
          text: 'Explain how to avoid unsafe links and passwords.',
          scores: { cybersecurity: 3, itSupportOperations: 1 },
        },
        {
          id: 'c',
          text: 'Build a small tool that prevents the issue happening again.',
          scores: { softwareDevelopment: 2, cloudDevops: 2 },
        },
        {
          id: 'd',
          text: 'Create a clear checklist or spreadsheet they can follow.',
          scores: { businessIt: 3, dataAi: 1 },
        },
      ],
    },
    {
      id: 'itdir-interest-011',
      dimension: 'interest',
      prompt: 'Which kind of puzzle do you enjoy most?',
      options: [
        {
          id: 'a',
          text: 'Logic puzzles where one small change affects the outcome.',
          scores: { softwareDevelopment: 3, dataAi: 1 },
        },
        {
          id: 'b',
          text: 'Mystery puzzles where clues reveal the cause.',
          scores: { cybersecurity: 2, itSupportOperations: 2 },
        },
        {
          id: 'c',
          text: 'Maps and connection puzzles where paths matter.',
          scores: { networkingInfrastructure: 3, cloudDevops: 1 },
        },
        {
          id: 'd',
          text: 'Sorting and organising puzzles where structure matters.',
          scores: { businessIt: 2, dataAi: 2 },
        },
      ],
    },
    {
      id: 'itdir-interest-012',
      dimension: 'interest',
      prompt: 'Which result would make you feel proud?',
      options: [
        {
          id: 'a',
          text: 'A working application that people actually use.',
          scores: { softwareDevelopment: 3, businessIt: 1 },
        },
        {
          id: 'b',
          text: 'A risky setting fixed before it causes harm.',
          scores: { cybersecurity: 3, cloudDevops: 1 },
        },
        {
          id: 'c',
          text: 'A reliable system that stays online during busy periods.',
          scores: { cloudDevops: 3, networkingInfrastructure: 1 },
        },
        {
          id: 'd',
          text: 'A frustrated user becoming confident with a tool.',
          scores: { itSupportOperations: 2, businessIt: 2 },
        },
      ],
    },
    {
      id: 'itdir-interest-013',
      dimension: 'interest',
      prompt: 'Which practical task would you volunteer for?',
      options: [
        {
          id: 'a',
          text: 'Write a script that renames and organises files.',
          scores: { softwareDevelopment: 2, cloudDevops: 1, businessIt: 1 },
        },
        {
          id: 'b',
          text: 'Review sign-in activity for strange behaviour.',
          scores: { cybersecurity: 3, dataAi: 1 },
        },
        {
          id: 'c',
          text: 'Label network cables and document where they connect.',
          scores: { networkingInfrastructure: 3, itSupportOperations: 1 },
        },
        {
          id: 'd',
          text: 'Build a dashboard that tracks client enquiries.',
          scores: { dataAi: 2, businessIt: 2 },
        },
      ],
    },
    {
      id: 'itdir-interest-014',
      dimension: 'interest',
      prompt: 'What kind of feedback do you enjoy receiving?',
      options: [
        {
          id: 'a',
          text: 'Your code works and handles the edge cases.',
          scores: { softwareDevelopment: 3, dataAi: 1 },
        },
        {
          id: 'b',
          text: 'Your investigation found the real cause.',
          scores: { cybersecurity: 2, itSupportOperations: 2 },
        },
        {
          id: 'c',
          text: 'Your setup is stable and easy to maintain.',
          scores: { cloudDevops: 2, networkingInfrastructure: 2 },
        },
        {
          id: 'd',
          text: 'Your process made the team more organised.',
          scores: { businessIt: 3, dataAi: 1 },
        },
      ],
    },
    {
      id: 'itdir-interest-015',
      dimension: 'interest',
      prompt: 'Which topic would you be most curious to explore?',
      options: [
        {
          id: 'a',
          text: 'How apps store and process user information.',
          scores: { softwareDevelopment: 2, dataAi: 1, cybersecurity: 1 },
        },
        {
          id: 'b',
          text: 'How attackers gain access and how teams respond.',
          scores: { cybersecurity: 3, networkingInfrastructure: 1 },
        },
        {
          id: 'c',
          text: 'How cloud systems scale when more users arrive.',
          scores: { cloudDevops: 3, softwareDevelopment: 1 },
        },
        {
          id: 'd',
          text: 'How office tools can reduce admin time.',
          scores: { businessIt: 3, dataAi: 1 },
        },
      ],
    },
    {
      id: 'itdir-interest-016',
      dimension: 'interest',
      prompt: 'Which first job task sounds least stressful?',
      options: [
        {
          id: 'a',
          text: 'Updating a simple web page or fixing a small bug.',
          scores: { softwareDevelopment: 3, businessIt: 1 },
        },
        {
          id: 'b',
          text: 'Checking whether user accounts have the correct permissions.',
          scores: { cybersecurity: 2, businessIt: 2 },
        },
        {
          id: 'c',
          text: 'Helping a user reset access and confirm their device works.',
          scores: { itSupportOperations: 3, cybersecurity: 1 },
        },
        {
          id: 'd',
          text: 'Checking why a shared drive or printer is unreachable.',
          scores: { networkingInfrastructure: 2, itSupportOperations: 2 },
        },
      ],
    },
    {
      id: 'itdir-interest-017',
      dimension: 'interest',
      prompt: 'Which kind of tool would you like to become good at?',
      options: [
        {
          id: 'a',
          text: 'Code editors and development tools.',
          scores: { softwareDevelopment: 3, cloudDevops: 1 },
        },
        {
          id: 'b',
          text: 'Security monitoring and investigation tools.',
          scores: { cybersecurity: 3, dataAi: 1 },
        },
        {
          id: 'c',
          text: 'Cloud dashboards, terminals, and automation tools.',
          scores: { cloudDevops: 3, networkingInfrastructure: 1 },
        },
        {
          id: 'd',
          text: 'Spreadsheets, forms, collaboration, and reporting tools.',
          scores: { businessIt: 2, dataAi: 2 },
        },
      ],
    },
    {
      id: 'itdir-interest-018',
      dimension: 'interest',
      prompt: 'Which statement sounds most like you?',
      options: [
        {
          id: 'a',
          text: 'I want to make things.',
          scores: { softwareDevelopment: 3, cloudDevops: 1 },
        },
        {
          id: 'b',
          text: 'I want to protect things.',
          scores: { cybersecurity: 3, networkingInfrastructure: 1 },
        },
        {
          id: 'c',
          text: 'I want to fix things.',
          scores: { itSupportOperations: 3, networkingInfrastructure: 1 },
        },
        {
          id: 'd',
          text: 'I want to organise and improve things.',
          scores: { businessIt: 2, dataAi: 2 },
        },
      ],
    },
    {
      id: 'itdir-interest-019',
      dimension: 'interest',
      prompt: 'Which situation would you rather be placed in?',
      options: [
        {
          id: 'a',
          text: 'A team needs a prototype by the end of the week.',
          scores: { softwareDevelopment: 3, cloudDevops: 1 },
        },
        {
          id: 'b',
          text: 'A team needs to understand whether an account was misused.',
          scores: { cybersecurity: 3, dataAi: 1 },
        },
        {
          id: 'c',
          text: 'A team needs the office network documented and tidied.',
          scores: { networkingInfrastructure: 3, itSupportOperations: 1 },
        },
        {
          id: 'd',
          text: 'A team needs a better onboarding process for new staff.',
          scores: { businessIt: 3, itSupportOperations: 1 },
        },
      ],
    },
    {
      id: 'itdir-interest-020',
      dimension: 'interest',
      prompt: 'Which improvement would you notice first?',
      options: [
        {
          id: 'a',
          text: 'A manual process could become a small app.',
          scores: { softwareDevelopment: 2, businessIt: 1, cloudDevops: 1 },
        },
        {
          id: 'b',
          text: 'A password or permission practice looks risky.',
          scores: { cybersecurity: 3, businessIt: 1 },
        },
        {
          id: 'c',
          text: 'A connection path or device setup could be cleaner.',
          scores: { networkingInfrastructure: 3, itSupportOperations: 1 },
        },
        {
          id: 'd',
          text: 'A report could show trends instead of raw rows.',
          scores: { dataAi: 3, businessIt: 1 },
        },
      ],
    },
    {
      id: 'itdir-interest-021',
      dimension: 'interest',
      prompt: 'Which long-term goal sounds most exciting?',
      options: [
        {
          id: 'a',
          text: 'Build applications and digital products.',
          scores: { softwareDevelopment: 3, cloudDevops: 1 },
        },
        {
          id: 'b',
          text: 'Help protect organisations from cyber risks.',
          scores: { cybersecurity: 3, networkingInfrastructure: 1 },
        },
        {
          id: 'c',
          text: 'Design reliable cloud and infrastructure systems.',
          scores: { cloudDevops: 2, networkingInfrastructure: 2 },
        },
        {
          id: 'd',
          text: 'Use technology to make business work smoother.',
          scores: { businessIt: 2, dataAi: 1, itSupportOperations: 1 },
        },
      ],
    },
    {
      id: 'itdir-knowledge-001',
      dimension: 'knowledge',
      prompt:
        'A user says their computer has no internet. What is the best first step?',
      options: [
        {
          id: 'a',
          text: 'Check basic connectivity, Wi-Fi or cable status, and whether other sites work.',
          scores: { itSupportOperations: 3, networkingInfrastructure: 2 },
        },
        {
          id: 'b',
          text: 'Immediately reinstall the operating system.',
          scores: { itSupportOperations: 1 },
        },
        {
          id: 'c',
          text: 'Assume the website is being attacked.',
          scores: { cybersecurity: 1 },
        },
        {
          id: 'd',
          text: 'Create a new spreadsheet to track the issue later.',
          scores: { businessIt: 1 },
        },
      ],
    },
    {
      id: 'itdir-knowledge-002',
      dimension: 'knowledge',
      prompt: 'What does a simple if/else statement usually help a program do?',
      options: [
        {
          id: 'a',
          text: 'Choose between actions based on a condition.',
          scores: { softwareDevelopment: 3, dataAi: 1 },
        },
        {
          id: 'b',
          text: 'Make a network cable faster.',
          scores: { networkingInfrastructure: 1 },
        },
        {
          id: 'c',
          text: 'Replace the need for passwords.',
          scores: { cybersecurity: 1 },
        },
        {
          id: 'd',
          text: 'Format a document heading.',
          scores: { businessIt: 1 },
        },
      ],
    },
    {
      id: 'itdir-knowledge-003',
      dimension: 'knowledge',
      prompt:
        'A message asks for your password and creates urgency. What should you do first?',
      options: [
        {
          id: 'a',
          text: 'Pause, verify the sender through a trusted channel, and avoid clicking the link.',
          scores: { cybersecurity: 3, businessIt: 1, itSupportOperations: 1 },
        },
        {
          id: 'b',
          text: 'Reply with the password so the account is not closed.',
          scores: { businessIt: 1 },
        },
        {
          id: 'c',
          text: 'Forward it to everyone so they can decide.',
          scores: { itSupportOperations: 1 },
        },
        {
          id: 'd',
          text: 'Ignore all future emails from that company.',
          scores: { cybersecurity: 1 },
        },
      ],
    },
    {
      id: 'itdir-knowledge-004',
      dimension: 'knowledge',
      prompt: 'What is an IP address mainly used for?',
      options: [
        {
          id: 'a',
          text: 'Identifying a device or service on a network.',
          scores: { networkingInfrastructure: 3, cloudDevops: 1 },
        },
        {
          id: 'b',
          text: 'Encrypting every file on a computer.',
          scores: { cybersecurity: 1 },
        },
        {
          id: 'c',
          text: 'Designing the colour of a website.',
          scores: { softwareDevelopment: 1 },
        },
        {
          id: 'd',
          text: 'Sorting spreadsheet columns automatically.',
          scores: { dataAi: 1 },
        },
      ],
    },
    {
      id: 'itdir-knowledge-005',
      dimension: 'knowledge',
      prompt: 'In simple terms, what is a cloud service?',
      options: [
        {
          id: 'a',
          text: 'Computing resources delivered over the internet instead of only on a local device.',
          scores: { cloudDevops: 3, networkingInfrastructure: 1 },
        },
        {
          id: 'b',
          text: 'A folder name that makes files invisible.',
          scores: { businessIt: 1 },
        },
        {
          id: 'c',
          text: 'A security tool that blocks every attack automatically.',
          scores: { cybersecurity: 1 },
        },
        {
          id: 'd',
          text: 'A programming language used only for phone apps.',
          scores: { softwareDevelopment: 1 },
        },
      ],
    },
    {
      id: 'itdir-knowledge-006',
      dimension: 'knowledge',
      prompt:
        'A spreadsheet has thousands of rows. Which action best helps find patterns?',
      options: [
        {
          id: 'a',
          text: 'Filter, sort, summarise, or visualise the data.',
          scores: { dataAi: 3, businessIt: 2 },
        },
        {
          id: 'b',
          text: 'Change every value manually before looking at it.',
          scores: { businessIt: 1 },
        },
        {
          id: 'c',
          text: 'Turn off the network connection.',
          scores: { networkingInfrastructure: 1 },
        },
        {
          id: 'd',
          text: 'Delete the headings to save space.',
          scores: { dataAi: 1 },
        },
      ],
    },
    {
      id: 'itdir-knowledge-007',
      dimension: 'knowledge',
      prompt: 'Why is multi-factor authentication useful?',
      options: [
        {
          id: 'a',
          text: 'It adds another proof of identity beyond just a password.',
          scores: { cybersecurity: 3, businessIt: 1 },
        },
        {
          id: 'b',
          text: 'It removes the need for user training.',
          scores: { businessIt: 1 },
        },
        {
          id: 'c',
          text: 'It guarantees that software has no bugs.',
          scores: { softwareDevelopment: 1 },
        },
        {
          id: 'd',
          text: 'It makes Wi-Fi signals stronger.',
          scores: { networkingInfrastructure: 1 },
        },
      ],
    },
    {
      id: 'itdir-knowledge-008',
      dimension: 'knowledge',
      prompt:
        'A business stores important files in one place only. What is the main risk?',
      options: [
        {
          id: 'a',
          text: 'If that place fails or is deleted, the business may lose the files.',
          scores: { itSupportOperations: 2, cloudDevops: 2, cybersecurity: 1 },
        },
        {
          id: 'b',
          text: 'The files will automatically become public.',
          scores: { cybersecurity: 1 },
        },
        {
          id: 'c',
          text: 'The files will become code.',
          scores: { softwareDevelopment: 1 },
        },
        {
          id: 'd',
          text: 'The files cannot be opened in a spreadsheet.',
          scores: { businessIt: 1 },
        },
      ],
    },
    {
      id: 'itdir-knowledge-009',
      dimension: 'knowledge',
      prompt:
        'Which option best describes a database?',
      options: [
        {
          id: 'a',
          text: 'An organised place to store, search, and update structured information.',
          scores: { dataAi: 2, softwareDevelopment: 2, businessIt: 1 },
        },
        {
          id: 'b',
          text: 'A physical cable that connects two computers.',
          scores: { networkingInfrastructure: 1 },
        },
        {
          id: 'c',
          text: 'A type of password reset.',
          scores: { itSupportOperations: 1 },
        },
        {
          id: 'd',
          text: 'A tool that prevents all malware.',
          scores: { cybersecurity: 1 },
        },
      ],
    },
    {
      id: 'itdir-knowledge-010',
      dimension: 'knowledge',
      prompt:
        'A web app update must be released repeatedly and safely. Which idea helps most?',
      options: [
        {
          id: 'a',
          text: 'Use a repeatable deployment process with testing and rollback planning.',
          scores: { cloudDevops: 3, softwareDevelopment: 2 },
        },
        {
          id: 'b',
          text: 'Manually copy random files and hope the site starts.',
          scores: { itSupportOperations: 1 },
        },
        {
          id: 'c',
          text: 'Disable monitoring so alerts do not appear.',
          scores: { businessIt: 1 },
        },
        {
          id: 'd',
          text: 'Give every user administrator access.',
          scores: { cybersecurity: 1 },
        },
      ],
    },
    {
      id: 'itdir-knowledge-011',
      dimension: 'knowledge',
      prompt:
        'A security alert shows a sign-in from a new country at 03:00. What is a sensible next step?',
      options: [
        {
          id: 'a',
          text: 'Review the user context, recent activity, and whether the sign-in was expected.',
          scores: { cybersecurity: 3, dataAi: 1, itSupportOperations: 1 },
        },
        {
          id: 'b',
          text: 'Delete the user account immediately without checking.',
          scores: { cybersecurity: 1 },
        },
        {
          id: 'c',
          text: 'Ignore it because alerts are never useful.',
          scores: { businessIt: 1 },
        },
        {
          id: 'd',
          text: 'Restart the office printer.',
          scores: { itSupportOperations: 1 },
        },
      ],
    },
    {
      id: 'itdir-knowledge-012',
      dimension: 'knowledge',
      prompt: 'What does DNS usually help with?',
      options: [
        {
          id: 'a',
          text: 'Translating names like example.com into network addresses.',
          scores: { networkingInfrastructure: 3, cloudDevops: 1 },
        },
        {
          id: 'b',
          text: 'Making a spreadsheet calculate totals.',
          scores: { dataAi: 1 },
        },
        {
          id: 'c',
          text: 'Writing all software code automatically.',
          scores: { softwareDevelopment: 1 },
        },
        {
          id: 'd',
          text: 'Approving employee leave requests.',
          scores: { businessIt: 1 },
        },
      ],
    },
    {
      id: 'itdir-knowledge-013',
      dimension: 'knowledge',
      prompt:
        'A task is repeated every day with the same steps. What IT idea may help?',
      options: [
        {
          id: 'a',
          text: 'Automation, using a script, workflow, or scheduled process.',
          scores: { softwareDevelopment: 2, cloudDevops: 2, businessIt: 1 },
        },
        {
          id: 'b',
          text: 'Making the task longer so mistakes are more visible.',
          scores: { businessIt: 1 },
        },
        {
          id: 'c',
          text: 'Turning off all notifications.',
          scores: { itSupportOperations: 1 },
        },
        {
          id: 'd',
          text: 'Changing the network name every day.',
          scores: { networkingInfrastructure: 1 },
        },
      ],
    },
    {
      id: 'itdir-knowledge-014',
      dimension: 'knowledge',
      prompt:
        'Before using data for a report, why might you clean it?',
      options: [
        {
          id: 'a',
          text: 'To fix missing, duplicated, or inconsistent values so the report is more reliable.',
          scores: { dataAi: 3, businessIt: 1 },
        },
        {
          id: 'b',
          text: 'To make the computer physically cooler.',
          scores: { itSupportOperations: 1 },
        },
        {
          id: 'c',
          text: 'To remove all security controls.',
          scores: { cybersecurity: 1 },
        },
        {
          id: 'd',
          text: 'To stop the network from routing traffic.',
          scores: { networkingInfrastructure: 1 },
        },
      ],
    },
    {
      id: 'itdir-knowledge-015',
      dimension: 'knowledge',
      prompt:
        'A staff member only needs to view customer records, not change them. What permission idea fits best?',
      options: [
        {
          id: 'a',
          text: 'Give the least access needed, such as read-only permission.',
          scores: { cybersecurity: 2, businessIt: 2 },
        },
        {
          id: 'b',
          text: 'Give full administrator access to save time.',
          scores: { itSupportOperations: 1 },
        },
        {
          id: 'c',
          text: 'Share one password with the whole team.',
          scores: { businessIt: 1 },
        },
        {
          id: 'd',
          text: 'Disable the database completely.',
          scores: { dataAi: 1 },
        },
      ],
    },
    {
      id: 'itdir-knowledge-016',
      dimension: 'knowledge',
      prompt:
        'Two users report the same app outage. What should a support team do early?',
      options: [
        {
          id: 'a',
          text: 'Check whether the issue is wider than one user and record the symptoms clearly.',
          scores: { itSupportOperations: 3, businessIt: 1, cloudDevops: 1 },
        },
        {
          id: 'b',
          text: 'Close both tickets because two reports are inconvenient.',
          scores: { businessIt: 1 },
        },
        {
          id: 'c',
          text: 'Assume both users typed too slowly.',
          scores: { itSupportOperations: 1 },
        },
        {
          id: 'd',
          text: 'Change all network addresses randomly.',
          scores: { networkingInfrastructure: 1 },
        },
      ],
    },
    {
      id: 'itdir-knowledge-017',
      dimension: 'knowledge',
      prompt:
        'What is one reason teams use containers or similar packaging for apps?',
      options: [
        {
          id: 'a',
          text: 'To run an app with a consistent environment across machines.',
          scores: { cloudDevops: 3, softwareDevelopment: 2 },
        },
        {
          id: 'b',
          text: 'To remove the need for testing forever.',
          scores: { softwareDevelopment: 1 },
        },
        {
          id: 'c',
          text: 'To make a Wi-Fi password longer.',
          scores: { cybersecurity: 1 },
        },
        {
          id: 'd',
          text: 'To sort email by sender.',
          scores: { businessIt: 1 },
        },
      ],
    },
    {
      id: 'itdir-knowledge-018',
      dimension: 'knowledge',
      prompt:
        'Which idea best supports secure access in modern systems?',
      options: [
        {
          id: 'a',
          text: 'Verify users and devices, limit access, and monitor for unusual behaviour.',
          scores: { cybersecurity: 3, cloudDevops: 1, networkingInfrastructure: 1 },
        },
        {
          id: 'b',
          text: 'Trust every device once it is inside the office.',
          scores: { networkingInfrastructure: 1 },
        },
        {
          id: 'c',
          text: 'Use the same password for every system.',
          scores: { businessIt: 1 },
        },
        {
          id: 'd',
          text: 'Only protect systems that have a blue icon.',
          scores: { itSupportOperations: 1 },
        },
      ],
    },
    {
      id: 'itdir-knowledge-019',
      dimension: 'knowledge',
      prompt:
        'A department wants fewer missed requests from clients. Which solution is most practical to start with?',
      options: [
        {
          id: 'a',
          text: 'Use a shared form or ticket process with ownership, status, and follow-up dates.',
          scores: { businessIt: 3, itSupportOperations: 1, dataAi: 1 },
        },
        {
          id: 'b',
          text: 'Ask clients to send messages to any staff member randomly.',
          scores: { businessIt: 1 },
        },
        {
          id: 'c',
          text: 'Turn off email for the department.',
          scores: { itSupportOperations: 1 },
        },
        {
          id: 'd',
          text: 'Make all requests confidential with no tracking.',
          scores: { cybersecurity: 1 },
        },
      ],
    },
  ],
};
