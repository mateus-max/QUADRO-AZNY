# Segurança Firebase — Remote Work Board

## Projeto Firebase oficial

- Project ID: `remot-board`
- Authentication domain: `remot-board.firebaseapp.com`
- Realtime Database: `https://remote-board-default-rtdb.firebaseio.com`
- Storage bucket: `remot-board.firebasestorage.app`
- Firebase CLI alias: `default` → `remot-board`

As páginas `index.html`, `dashboard.html` e `quadro_virtual_azny_quadro.html`, bem como o Admin SDK das Cloud Functions, foram apontados para este projeto novo. O projeto antigo `quadro-azny` deixou de ser a configuração usada pelo código atualizado. Não apagar os dados antigos até terminar a migração e validar o novo ambiente.


## Estado atual — novo projeto preparado, migração em andamento

Foram adicionados:
- `database.rules.json`: regras restritivas para Realtime Database, com permissões por sala, função e sessão.
- `functions/index.js`: funções confiáveis para validar a licença do professor, aprovar alunos, registar aulas de teste e criar links curtos.
- `functions/package.json` e `firebase.json`: configuração inicial para Cloud Functions e regras.
- O quadro passou a chamar funções seguras para validação do professor, aprovação do aluno, contagem do trial e criação do link curto.

**Ainda não publicar as regras.** A ativação de licença foi transferida para a função `activateApprovedLicense`, que confirma no servidor a autenticação, o e-mail, o pedido e o estado aprovado antes de criar/substituir a licença. A consulta de licenças também usa funções confiáveis. Porém, o fluxo de pedidos e a aprovação administrativa ainda dependem de acesso direto a `paymentRequests` no cliente. Enquanto um cliente puder alterar o estado de um pedido para `approved`, a função de ativação não pode ser considerada segura. O fluxo de submissão, leitura de estado e aprovação administrativa tem de ser migrado para funções com validação de permissões antes de publicar as regras restritivas.

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

1. Migrar submissão e consulta de `paymentRequests` para funções confiáveis.\n2. Migrar a aprovação administrativa para uma função que valide uma lista de UIDs administrativos confiáveis; nunca aceitar `status: approved` escrito pelo navegador.\n3. Manter criação, substituição, leitura e atualização de licenças exclusivamente nas funções; não abrir `licenses` a clientes.
2. Rever os restantes caminhos e operações RTDB do repositório, incluindo fluxos administrativos e de pagamento.
3. Instalar dependências e validar as Cloud Functions com Firebase Emulator Suite.
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
