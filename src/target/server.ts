import type http from 'node:http';

import express from 'express';

const syntheticMember = {
  id: '12345',
  name: 'SYNTHETIC MEMBER ALPHA',
  savingsBalance: '$1,234.56',
};

const renderShell = (content: string, scenario: string) => `<!doctype html>
<html>
  <head><title>Synthetic Credit Union Shell</title></head>
  <body>
    <table border="1" width="100%"><tr><td><strong>Synthetic Legacy Credit Union Portal</strong></td></tr></table>
    <p>All data is synthetic. Scenario: ${scenario}</p>
    <iframe title="legacy-app-frame" name="legacy-app-frame" src="/app/home?scenario=${encodeURIComponent(scenario)}" width="100%" height="720"></iframe>
    ${content}
  </body>
</html>`;

const tableLayout = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>
<table border="1" cellpadding="6" cellspacing="0" width="100%">
<tr><td colspan="2"><h1>${title}</h1></td></tr>
${body}
</table></body></html>`;

const delay = async (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const createTargetServer = (port = 3000) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));

  app.get('/healthz', (_request, response) => {
    response.json({ ok: true });
  });

  app.get('/', (request, response) => {
    const scenario = String(request.query.scenario ?? 'member-found');
    response.send(renderShell('', scenario));
  });

  app.get('/app/home', (request, response) => {
    const scenario = String(request.query.scenario ?? 'member-found');
    response.send(
      tableLayout(
        'Legacy Servicing Home',
        `<tr><td>Navigation</td><td><a href="/app/member-search?scenario=${encodeURIComponent(scenario)}">Member Search</a></td></tr>`
      )
    );
  });

  app.get('/app/member-search', async (request, response) => {
    const scenario = String(request.query.scenario ?? 'member-found');
    const message = String(request.query.message ?? '');
    if (scenario === 'slow-load') {
      await delay(250);
    }
    response.send(
      tableLayout(
        'Member Search',
        `<tr><td colspan="2">All member data is synthetic.</td></tr>
         ${message ? `<tr><td colspan="2"><strong>${message}</strong></td></tr>` : ''}
         <tr><td>Member ID</td><td><form method="post" action="/app/member-search?scenario=${encodeURIComponent(scenario)}">
           <input name="memberId" aria-label="Member ID" />
           <button type="submit">Search Member</button>
         </form></td></tr>`
      )
    );
  });

  app.post('/app/member-search', async (request, response) => {
    const scenario = String(request.query.scenario ?? 'member-found');
    const memberId = String(request.body.memberId ?? '').trim();
    if (scenario === 'slow-load') {
      await delay(250);
    }
    if (scenario === 'session-expired') {
      response.redirect('/app/session-expired');
      return;
    }
    if (scenario === 'permission-denied') {
      response.redirect('/app/permission-denied');
      return;
    }
    if (scenario === 'application-error') {
      response.redirect('/app/application-error');
      return;
    }
    if (!memberId) {
      response.redirect(`/app/member-search?scenario=${encodeURIComponent(scenario)}&message=${encodeURIComponent('Validation error: member id is required.')}`);
      return;
    }
    if (scenario === 'validation-error') {
      response.redirect(`/app/member-search?scenario=${encodeURIComponent(scenario)}&message=${encodeURIComponent('Validation error: synthetic flow rejected the request.')}`);
      return;
    }
    if (scenario === 'member-not-found' || memberId !== syntheticMember.id) {
      response.redirect(`/app/member-search?scenario=${encodeURIComponent(scenario)}&message=${encodeURIComponent('No synthetic member matched the supplied id.')}`);
      return;
    }
    response.redirect(`/app/member/${syntheticMember.id}?scenario=${encodeURIComponent(scenario)}`);
  });

  app.get('/app/member/:memberId', async (request, response) => {
    const scenario = String(request.query.scenario ?? 'member-found');
    if (scenario === 'slow-load' && request.query.loaded !== '1') {
      response.send(
        tableLayout(
          'Loading Member Details',
          `<tr><td colspan="2">Loading synthetic member details...</td></tr>
           <tr><td colspan="2"><script>setTimeout(function(){ window.location.href='/app/member/${syntheticMember.id}?scenario=slow-load&loaded=1'; }, 350);</script></td></tr>`
        )
      );
      return;
    }
    response.send(
      tableLayout(
        'Member Details',
        `<tr><td>Member Name</td><td>${syntheticMember.name}</td></tr>
         <tr><td class="balance-label">Savings Balance</td><td id="savings-balance">${syntheticMember.savingsBalance}</td></tr>
         <tr><td>Actions</td><td>
           <a href="/app/open-sub-account/start?scenario=${encodeURIComponent(scenario)}">Open Sub-Account</a>
           ${scenario === 'unexpected-dialog' ? `<script>setTimeout(function(){ confirm('Unexpected confirmation dialog'); }, 50);</script>` : ''}
         </td></tr>`
      )
    );
  });

  app.get('/app/open-sub-account/start', (request, response) => {
    const scenario = String(request.query.scenario ?? 'member-found');
    response.send(
      tableLayout(
        'Open Sub-Account - Step 1',
        `<tr><td>Product</td><td>
           <form method="post" action="/app/open-sub-account/start?scenario=${encodeURIComponent(scenario)}">
             <select name="product" aria-label="Product"><option>Synthetic Holiday Club</option></select>
             <button type="submit">Continue</button>
           </form></td></tr>`
      )
    );
  });

  app.post('/app/open-sub-account/start', (request, response) => {
    const scenario = String(request.query.scenario ?? 'member-found');
    const product = String(request.body.product ?? 'Synthetic Holiday Club');
    response.redirect(`/app/open-sub-account/review?scenario=${encodeURIComponent(scenario)}&product=${encodeURIComponent(product)}`);
  });

  app.get('/app/open-sub-account/review', (request, response) => {
    const scenario = String(request.query.scenario ?? 'member-found');
    const product = String(request.query.product ?? 'Synthetic Holiday Club');
    response.send(
      tableLayout(
        'Open Sub-Account - Review',
        `<tr><td>Review</td><td>Synthetic only. No real transaction will be executed.</td></tr>
         <tr><td>Requested Product</td><td>${product}</td></tr>
         <tr><td>Actions</td><td><button>Confirm Submission</button></td></tr>
         <tr><td>Scenario</td><td>${scenario}</td></tr>`
      )
    );
  });

  app.get('/app/permission-denied', (_request, response) => {
    response.status(403).send(tableLayout('Permission Denied', '<tr><td colspan="2">Permission denied for synthetic operator.</td></tr>'));
  });
  app.get('/app/session-expired', (_request, response) => {
    response.status(440).send(tableLayout('Session Expired', '<tr><td colspan="2">Session expired. Reauthenticate in synthetic environment.</td></tr>'));
  });
  app.get('/app/application-error', (_request, response) => {
    response.status(500).send(tableLayout('Application Error', '<tr><td colspan="2">Synthetic application error triggered by scenario.</td></tr>'));
  });

  let server: http.Server | undefined;
  return {
    port,
    app,
    async start(): Promise<void> {
      await new Promise<void>((resolve) => {
        server = app.listen(port, '127.0.0.1', () => resolve());
      });
    },
    async stop(): Promise<void> {
      if (!server) {
        return;
      }
      await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
      server = undefined;
    },
  };
};
