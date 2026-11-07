# Segurança Firebase — Remote Work Board

## Projeto Firebase oficial

- Project ID: `remot-board`
- Authentication domain: `remot-board.firebaseapp.com`
- Realtime Database: `https://remote-board-default-rtdb.firebaseio.com`
- Storage bucket: `remot-board.firebasestorage.app`
- Firebase CLI alias: `default` → `remot-board`

As páginas `index.html`, `dashboard.html` e `quadro_virtual_azny_quadro.html`, bem como o Admin SDK das Cloud Functions, foram apontados para este projeto novo. O projeto antigo `quadro-azny` deixou de ser a configuração usada pelo código atualizado. Não apagar os dados antigos até terminar a migração e validar o novo ambiente.


## Estado atual — novo projeto preparado, migração em andamento

Foram adicionados e ligados ao portal:
- `database.rules.json`: regras restritivas de base para Realtime Database; o nó do quadro permite leitura/escrita apenas a participantes aprovados e valida página atual, máximo de cinco páginas e UID do último editor. Ainda não publicar sem testes de compatibilidade.
- `functions/index.js`: funções para validação de licença, pedidos de pagamento/teste, aprovação administrativa, comprovativos, feedback, aprovação de alunos e links curtos.
- `functions/package.json` e `firebase.json`: configuração inicial de Cloud Functions e regras.
- `index.html`: pedidos, consulta do estado, feedback e consulta/ativação de licença passam pelas Cloud Functions.
- `quadro_virtual_azny_quadro.html`: professor e alunos aprovados publicam o estado do quadro no Firebase com debounce curto; o canal WebRTC continua ativo como via rápida entre participantes. O listener de estado partilhado distribui as alterações aos participantes.
- `admin.html`: painel administrativo com login por e-mail/palavra-passe, lista de pedidos sem devolver comprovativos em massa e visualização de cada comprovativo através de uma função separada e protegida.

**Ainda não publicar as regras.** As operações financeiras principais já foram transferidas para funções. A aprovação administrativa grava o estado no servidor; a ativação da licença ocorre quando o titular autenticado entra e chama `activateApprovedLicense`, que valida o e-mail e o pedido aprovado antes de criar/substituir a licença. É necessário testar este percurso completo no Emulator Suite antes do deploy.

## Modelo de autorização

O servidor gere `roomAccess/{roomKey}/{uid}`; os clientes não podem ler nem escrever essa árvore.

Professor:
```json
{ "role": "teacher", "status": "approved" }
```

Aluno aprovado:
```json
{ "role": "student", "status": "approved", "requestId": "ID_DO_PEDIDO" }
```

## Funções criadas

- `verifyTeacherAccess`: verifica token, estado, validade e limite do trial; cria a autorização do professor.\n- `activateApprovedLicense`: cria ou substitui a licença no servidor apenas se encontrar um pedido aprovado para o e-mail autenticado.
- `approveStudentRequest`: confirma que quem aprova é o professor autorizado, cria a autorização do aluno e atualiza o pedido.
- `grantApprovedStudentRoomAccess`: gatilho de reconciliação para pedidos aprovados.
- `recordTrialClass`: contabiliza aulas de teste no servidor.
- `createClassShortLink`: cria links curtos no servidor.

## Antes de publicar

1. Rever os restantes caminhos e operações RTDB do repositório, incluindo avaliações, presença, gravações, publicações e ferramentas do quadro.
2. Testar concorrência real: professor + dois ou mais alunos a escrever, desenhar, mover e apagar objetos ao mesmo tempo. Confirmar que nenhum snapshot atrasado apaga traços ou objetos de outro participante.
3. Testar a sincronização em Android e computador, redes móveis lentas, perda de ligação e reconexão; medir latência e verificar recuperação do estado.
4. Só depois confirmar todas as leituras/escritas necessárias nas regras.
5. Confirmar que todas as leituras/escritas necessárias estão cobertas pelas regras e que nenhum cliente escreve diretamente em `licenses`, `paymentRequests`, `feedback` ou `roomAccess`.
6. Manter criação, substituição, leitura e atualização de licenças exclusivamente nas funções; não abrir `licenses` a clientes.
7. Instalar dependências e validar as Cloud Functions com Firebase Emulator Suite.
4. Testar professor, aluno pendente, aluno aprovado, conta não autenticada, licenças expiradas e trial esgotado.
5. Só depois publicar conjuntamente funções e regras com `firebase deploy --only functions,database`.

Não substituir as regras atualmente publicadas até concluir todos os passos. O ficheiro JSON no GitHub não altera automaticamente o Firebase Console.

## Configuração ainda necessária no novo projeto

1. Em Authentication, ativar os métodos realmente usados pela aplicação: E-mail/palavra-passe, Google e acesso anónimo (o quadro utiliza autenticação anónima para participantes).
2. Confirmar que o Realtime Database está na região e URL indicadas acima.
3. Publicar `database.rules.json` apenas depois de migrar os fluxos de `paymentRequests` e feedback para funções confiáveis; as regras atuais são restritivas e não são compatíveis com todos os fluxos legados do portal.
4. Instalar/deploy das Cloud Functions no projeto `remot-board` com credenciais autorizadas e plano Firebase compatível. O código no GitHub, por si só, não publica Functions nem regras.
5. Testar login, pedido de pagamento, aprovação administrativa, ativação da licença, professor, aluno, sincronização do quadro e gravações antes de apontar o domínio público para o novo ambiente.

**Importante:** a troca das configurações no código não migra os dados, não cria automaticamente os utilizadores de Authentication, não publica as regras e não implanta as Cloud Functions. O novo banco mostrado no Console estava vazio (`null`) no momento da captura.


## Modelo detalhado

Consultar `FIREBASE_DATA_MODEL.md` para a árvore de dados, papéis, limites e sequência de ativação no projeto novo.


## Migração financeira para Cloud Functions

Foram adicionadas as funções:
- `createPaymentRequest`: recebe o comprovativo e cria pedido pendente no servidor, associando-o ao UID e e-mail autenticados; impede pedidos pendentes/ativos duplicados.
- `createTrialRequest`: regista pedidos de teste no servidor.
- `getMyPaymentRequests`: devolve apenas pedidos da própria conta, sem expor comprovativos.
- `adminListPaymentRequests`: lista pedidos apenas para administradores autorizados, sem incluir os dados binários dos comprovativos.
- `adminGetPaymentProof`: entrega um comprovativo individual apenas a um administrador autorizado.
- `adminSetPaymentStatus`: aprova/rejeita no servidor, grava o UID do administrador e cria registo de auditoria.
- `submitFeedback`: recebe sugestões sem escrita direta na base de dados.
- `activateApprovedLicense`: lê o pedido pelo ID, confirma estado aprovado e e-mail autenticado e só então cria a licença.

O `index.html` foi alterado para enviar pedidos, consultar o próprio estado e submeter feedback através das funções. Foi criado `admin.html`, um painel de análise que chama exclusivamente funções protegidas.

### Configurar o primeiro administrador

O repositório administrativo existente `mateus-max/ADMN.QUADRO` foi inspecionado. O seu ficheiro `index.html` identifica a conta administrativa pelo e-mail `suporte@domingas.com` e autentica essa conta com Firebase Authentication (e-mail e palavra-passe). Por isso, a autorização das novas funções foi ajustada para aceitar o e-mail administrativo existente, em vez de exigir que o utilizador forneça manualmente um UID.

1. Configurar o parâmetro seguro `ADMIN_EMAILS=suporte@domingas.com` no ambiente de deploy das Cloud Functions do projeto `remot-board`.
2. Publicar as funções.
3. Entrar em `admin.html` usando a mesma conta Google/Firebase associada a esse e-mail. Se a conta administrativa existente não for Google, adaptar o painel para autenticação por e-mail e palavra-passe em vez de Google.

**Atenção:** o ficheiro administrativo contém uma palavra-passe escrita diretamente no código. Não a reproduzo aqui. Recomendo alterá-la e removê-la do HTML; a autenticação deve depender exclusivamente do Firebase Authentication. O repositório administrativo legado usa o projeto `quadro-azny`; o Remote Work Board atualizado usa `remot-board`. O painel `admin.html` criado neste repositório está apontado para `remot-board`. Não confundir os dois projetos.

**Ainda não publicar as regras no Console:** os restantes módulos (avaliações, publicações e supervisão) ainda precisam de revisão/migração para as novas regras. As funções também precisam de deploy e validação no projeto Firebase antes de ativar as regras definitivas.
