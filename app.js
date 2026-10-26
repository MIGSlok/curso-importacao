const $ = (selector) => document.querySelector(selector);
const auth = $('#auth');
fetch('/api/health').then((r) => r.json()).then((config) => {
  if (config.checkoutMode !== 'test') return;
  const banner = document.createElement('div');
  const priceLabel = new Intl.NumberFormat('pt-BR', {style:'currency', currency:'BRL'}).format(config.priceCents / 100);
  banner.textContent = `AMBIENTE DE TESTE · Curso Básico ${priceLabel} · Pagamentos simulados`;
  banner.style.cssText = 'background:#c5f36b;color:#172013;text-align:center;padding:10px 16px;font:600 12px sans-serif;letter-spacing:.03em';
  document.body.prepend(banner);
}).catch(() => {});
if (auth) {
  let mode = 'login';
  let waitingForCode = false;
  const message = $('#auth-message');
  const accountMessage = $('#product-message');
  const refreshPayment = document.createElement('button');
  refreshPayment.type = 'button'; refreshPayment.className = 'btn secondary';
  refreshPayment.textContent = 'Conferir pagamento'; refreshPayment.hidden = true;
  refreshPayment.style.marginTop = '10px';
  $('#checkout').after(refreshPayment);
  async function api(url, data) {
    const response = await fetch(url, { method: data ? 'POST' : 'GET', credentials: 'same-origin', headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined });
    const result = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
    if (!response.ok) throw new Error(result?.error || 'Não foi possível concluir a solicitação.');
    return result;
  }
  function showMessage(el, text) { if (el) el.textContent = text || ''; }
  function setMode(next) {
    mode = next; waitingForCode = false;
    document.querySelectorAll('[data-mode]').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
    $('#submit').textContent = mode === 'login' ? 'Entrar na conta ↗' : 'Criar conta ↗';
    $('#code-wrap').hidden = true; $('#auth-form').elements.code.required = false;
    showMessage(message, '');
  }
  document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
  async function loadAccount() {
    const data = await api('/api/me');
    if (!data.authenticated) return;
    auth.style.display = 'none'; $('#dashboard').style.display = 'block'; $('#welcome').textContent = data.email;
    const statusText = { pending: 'Pagamento pendente. O PDF será liberado após a confirmação do provedor.', rejected: 'O pagamento não foi aprovado. Você pode tentar novamente pelo checkout.', cancelled: 'O pagamento foi cancelado. Você pode tentar novamente pelo checkout.' };
    $('#product-status').textContent = data.ownsBasic ? 'Pagamento confirmado. O curso está liberado nesta conta.' : (statusText[data.latestPaymentStatus] || 'Você ainda não tem o curso básico nesta conta.');
    $('#download').hidden = !data.ownsBasic; $('#checkout').hidden = data.ownsBasic;
    $('#checkout').disabled = !data.checkoutReady;
    $('#checkout').style.opacity = data.checkoutReady ? '1' : '.55';
    const priceLabel = new Intl.NumberFormat('pt-BR', {style:'currency', currency:'BRL'}).format(data.priceCents / 100);
    $('#checkout').textContent = data.checkoutReady ? (data.checkoutMode === 'test' ? `Testar compra por ${priceLabel} ↗` : 'Ir para pagamento seguro ↗') : 'Ativando checkout de teste';
    refreshPayment.hidden = data.ownsBasic || !data.latestPaymentStatus;
    if (!data.ownsBasic && !data.checkoutReady) showMessage(accountMessage, 'O ambiente está disponível; a credencial de pagamento ainda está sendo ativada.');
    $('#twofa-status').textContent = data.twoFactorEnabled ? 'Ativo. Seu login pede o código do aplicativo autenticador.' : 'Desativado. Ative para adicionar uma camada extra à sua conta.';
    $('#setup').hidden = data.twoFactorEnabled; $('#disable-form').hidden = !data.twoFactorEnabled;
  }
  $('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); showMessage(message, 'Processando...');
    try {
      if (waitingForCode) {
        await api('/api/2fa/verify-login', { code: form.get('code') }); waitingForCode = false;
      } else {
        const result = await api(mode === 'login' ? '/api/login' : '/api/register', { email: form.get('email'), password: form.get('password') });
        if (result.requiresTwoFactor) { waitingForCode = true; $('#code-wrap').hidden = false; $('#auth-form').elements.code.required = true; $('#submit').textContent = 'Confirmar código ↗'; showMessage(message, 'Digite o código do seu aplicativo autenticador.'); return; }
      }
      showMessage(message, ''); await loadAccount();
    } catch (error) { showMessage(message, error.message); }
  });
  $('#logout').addEventListener('click', async () => { try { await api('/api/logout', {}); location.reload(); } catch (error) { showMessage(accountMessage, error.message); } });
  async function reconcilePayment() {
    showMessage(accountMessage, 'Consultando confirmação no Mercado Pago...');
    try {
      const result = await api('/api/payments/reconcile', {});
      await loadAccount();
      showMessage(accountMessage, result.ownsBasic ? 'Pagamento confirmado. Acesso liberado.' : 'O pagamento ainda não foi aprovado. Você pode conferir novamente depois.');
    } catch (error) { showMessage(accountMessage, error.message); }
  }
  refreshPayment.addEventListener('click', reconcilePayment);
  $('#checkout').addEventListener('click', async () => { showMessage(accountMessage, 'Abrindo checkout seguro...'); try { const result = await api('/api/checkout', {}); location.assign(result.checkoutUrl); } catch (error) { showMessage(accountMessage, error.message); } });
  $('#download').addEventListener('click', () => { location.assign('/api/course/download'); });
  $('#setup').addEventListener('click', async () => { try { const data = await api('/api/2fa/setup', {}); $('#secret').textContent = data.secret; $('#enroll').hidden = false; } catch (error) { showMessage(accountMessage, error.message); } });
  $('#enable-form').addEventListener('submit', async (event) => { event.preventDefault(); const code = new FormData(event.currentTarget).get('code'); try { await api('/api/2fa/enable', { code }); await loadAccount(); $('#enroll').hidden = true; } catch (error) { showMessage(accountMessage, error.message); } });
  $('#disable-form').addEventListener('submit', async (event) => { event.preventDefault(); const code = new FormData(event.currentTarget).get('code'); try { await api('/api/2fa/disable', { code }); await loadAccount(); } catch (error) { showMessage(accountMessage, error.message); } });
  loadAccount().then(() => {
    if (new URLSearchParams(location.search).has('payment') && $('#dashboard').style.display === 'block') return reconcilePayment();
  }).catch((error) => showMessage(message, error.message));
  if (new URLSearchParams(location.search).get('payment') === 'return') showMessage(message, 'Pagamento em processamento. Entre na conta para ver o acesso assim que o provedor confirmar.');
  if (new URLSearchParams(location.search).get('payment') === 'pending') showMessage(message, 'Pagamento pendente. O acesso será liberado após a confirmação do provedor.');
}
