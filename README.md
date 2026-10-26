# Portal do curso CSSBuy

## Ambiente publicado para testes

Site: https://cssbuy-curso-teste.vercel.app — portal: https://cssbuy-curso-teste.vercel.app/portal.html.

Preço de teste: R$ 1,00 fictício, autorizado pelo usuário após o Mercado Pago não disponibilizar meios de pagamento para o centavo. A hospedagem está em modo `MERCADOPAGO_MODE=test` e só cria preferências após confirmar pela API que o vendedor é uma conta `test_user`. O Checkout Pro usa `init_point` também nos testes, conforme a documentação atual do Mercado Pago. O botão “Conferir pagamento” consulta a API no servidor e confere vendedor, referência, valor e moeda antes de liberar acesso.

Para testar, use uma janela anônima e um comprador de teste separado da sua conta real. Use somente os cartões fictícios oficiais do painel Mercado Pago. O material PDF original ainda precisa ser colocado em armazenamento privado para completar a entrega do curso; esta publicação valida o fluxo de login e checkout.

O banco da hospedagem é PostgreSQL externo da Neon, separado do SQLite local. O banco inicial é gratuito e temporário, com expiração em 29/10/2026 às 03:07 (Brasília), salvo se assumido em uma conta Neon. O comando `node scripts/provision-test-db.mjs --claim` gera o link de transferência para manter o projeto. Após transferir, atualize `DATABASE_URL` na Vercel com a nova conexão, pois a Neon troca a credencial durante a transferência.

As credenciais locais auxiliares ficam em `.env.hosting`, `.env.mp-test` e `.env.neon-identity`, todos ignorados pelo Git. A Vercel guarda os segredos como variáveis criptografadas. `hosting.json` contém somente os identificadores públicos do projeto.

A landing page continua em `index.html`. O portal de cadastro/login fica em `portal.html`; o servidor Node mantém as contas, sessões, pedidos e confirmação do pagamento.

## Iniciar localmente

1. Instale Node.js 20 ou mais recente.
2. Na pasta do projeto, execute `npm install`.
3. Copie `.env.example` para `.env`.
4. Gere a chave para criptografar os segredos TOTP com `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` e preencha `TOTP_ENCRYPTION_KEY`.
5. Escolha o preço real do curso em `COURSE_PRICE_BRL` (exemplo de formato: `49.90`).
6. Execute `npm start` e abra `http://localhost:3000`.

O botão do checkout não cria cobrança até existir preço positivo, token do Mercado Pago, segredo de webhook e uma URL HTTPS em `APP_URL`. Não coloque tokens em arquivos HTML, JavaScript do navegador, Git ou mensagens públicas.

## Ligar o checkout do Mercado Pago

1. Crie uma aplicação no painel de desenvolvedores do Mercado Pago e configure o Checkout Pro.
2. Copie o Access Token de teste para `MERCADOPAGO_ACCESS_TOKEN` durante a homologação. Para vender, use o token de produção da conta do vendedor.
3. Publique este servidor em um domínio HTTPS. Configure `APP_URL` com a origem pública completa, sem barra no final, como `https://seudominio.com`.
4. No painel da aplicação do Mercado Pago, cadastre o webhook `https://seudominio.com/api/payments/webhook` para o evento Pagamentos e copie a chave secreta para `MERCADOPAGO_WEBHOOK_SECRET`.
5. Preencha `COURSE_PRICE_BRL` com o preço decidido por você, reinicie o servidor e simule uma notificação de pagamento no painel.

O pedido é criado no servidor, com preço fixo da configuração. O navegador nunca informa o valor. O servidor valida a assinatura do webhook e consulta o pagamento diretamente na API do Mercado Pago; só registra acesso quando valor, moeda, pedido e estado aprovado coincidem. Voltar da tela do checkout não libera o curso por si só.

## Instalar o PDF privado

O PDF que foi gerado no chat **“Curso de Importação Cssbuy”** não está na pasta local deste projeto. Baixe o anexo desse chat e coloque uma cópia em `private/course-basic.pdf` no servidor. Esse arquivo está no `.gitignore`, e o Express não publica a pasta `private`. O download acontece pela rota protegida `/api/course/download`, depois da confirmação de compra.

## Segurança implementada

- **Senha:** armazenada como hash scrypt com salt aleatório por conta; não é guardada em texto puro nem criptografada de forma reversível.
- **Sessão:** token aleatório de 256 bits, armazenado no banco apenas como SHA-256; cookie `HttpOnly`, `SameSite=Lax` e `Secure` em produção. Sessões expiram em sete dias e são trocadas após login.
- **Rate limits:** 8 tentativas por 15 minutos em cadastro, login e ações TOTP; 5 criações de checkout por hora e limite geral de API. Os contadores são gravados no banco, compartilhados entre instâncias na hospedagem.
- **2FA:** o aluno pode configurar um aplicativo TOTP (Google Authenticator, Microsoft Authenticator ou compatível). O segredo fica criptografado com AES-256-GCM; a chave está em `TOTP_ENCRYPTION_KEY`, nunca no banco em claro.
- **Pagamento e download:** o retorno do checkout não vale como comprovante. A liberação exige confirmação verificada no servidor e cada download volta a conferir a conta e a compra.
- **.env:** ignorado pelo Git. O repositório contém somente `.env.example`, sem credenciais.
- **Cabeçalhos e CSRF:** Helmet aplica cabeçalhos e CSP; os POST do site exigem a mesma origem. Webhook usa validação de assinatura do Mercado Pago.

O rate limit é por endereço IP e persiste no banco; atrás de proxy, ajuste `TRUST_PROXY` ao número real de proxies usados na hospedagem. Configure backups e preserve a chave TOTP: sem ela, segredos 2FA já gravados não podem ser descriptografados.

## Pendências para operar

- Escolher preço, configurar uma conta de vendedor Mercado Pago e cadastrar as credenciais no ambiente da hospedagem.
- Hospedar em HTTPS para que checkout/webhook funcionem publicamente.
- Baixar do chat e instalar o PDF em `private/course-basic.pdf`.
- Antes de anunciar, acrescentar política de privacidade, termos de compra, contato de suporte e regras de reembolso próprias.

O curso avançado está planejado como uma segunda etapa: ensinará como ganhar dinheiro com importação, avaliar produtos para revenda, calcular margem e organizar uma operação comercial. Ele também incluirá as fontes de compra selecionadas pelo instrutor. As fontes devem ser revisadas antes do lançamento, e o conteúdo não deve prometer lucro garantido: resultados dependem de custos, demanda, tributos, fornecedores e execução.

O cadastro não envia e-mail de confirmação ou recuperação de senha porque ainda não há serviço de e-mail configurado. CSSBuy e Mercado Pago são marcas de seus respectivos proprietários; este curso não representa endosso dessas empresas.
