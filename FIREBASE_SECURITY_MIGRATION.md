# Segurança Firebase — Quadro AZNY

## Estado atual — migração em andamento

Foram adicionados:
- `database.rules.json`: regras restritivas para Realtime Database, com permissões por sala, função e sessão.
- `functions/index.js`: funções confiáveis para validar a licença do professor, aprovar alunos, registar aulas de teste e criar links curtos.
- `functions/package.json` e `firebase.json`: configuração inicial para Cloud Functions e regras.
- O quadro passou a chamar funções seguras para validação do professor, aprovação do aluno, contagem do trial e criação do link curto.

**Ainda não publicar as regras.** A migração não está completa: `index.html` cria/atualiza licenças diretamente no Realtime Database e `dashboard.html` lê licenças diretamente. Se as regras de produção negarem o acesso de clientes a `licenses`, esses fluxos de registo, compra/ativação e consulta de conta poderão falhar. Esses fluxos precisam ser movidos para funções confiáveis antes da publicação.

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

- `verifyTeacherAccess`: verifica token, estado, validade e limite do trial; cria a autorização do professor.
- `approveStudentRequest`: confirma que quem aprova é o professor autorizado, cria a autorização do aluno e atualiza o pedido.
- `grantApprovedStudentRoomAccess`: gatilho de reconciliação para pedidos aprovados.
- `recordTrialClass`: contabiliza aulas de teste no servidor.
- `createClassShortLink`: cria links curtos no servidor.

## Antes de publicar

1. Migrar a criação, substituição, leitura e atualização de licenças usadas por `index.html` e `dashboard.html` para funções confiáveis; não abrir `licenses` a todos os clientes.
2. Rever os restantes caminhos e operações RTDB do repositório, incluindo fluxos administrativos e de pagamento.
3. Instalar dependências e validar as Cloud Functions com Firebase Emulator Suite.
4. Testar professor, aluno pendente, aluno aprovado, conta não autenticada, licenças expiradas e trial esgotado.
5. Só depois publicar conjuntamente funções e regras com `firebase deploy --only functions,database`.

Não substituir as regras atualmente publicadas até concluir todos os passos. O ficheiro JSON no GitHub não altera automaticamente o Firebase Console.
