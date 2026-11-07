# Segurança Firebase — Quadro AZNY

## Estado atual — migração em andamento

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
