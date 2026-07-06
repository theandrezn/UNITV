update public.knowledge_articles
set content = replace(
      replace(content, 'https://www.youtube.com/watch?v=XlCPDdqnOuI', 'https://www.youtube.com/watch?v=LBBAbs2-I0c'),
      '5950878',
      '8322904'
    ),
    updated_at = now()
where content like '%XlCPDdqnOuI%'
   or content like '%5950878%';

insert into public.knowledge_articles (category, title, content, status, metadata)
values (
  'compatibilidade',
  'Aparelhos compativeis com a UNITV',
  E'A UNITV funciona somente em aparelhos Android ou baseados em Android.\n\nCompativeis: TV Box Android, Android TV, Google TV, celular Android, Fire Stick e televisao Android com Play Store.\n\nNao envie APK Android diretamente para iPhone, Roku, Samsung, LG, computador ou aparelho desconhecido. Para Samsung e LG, confirme primeiro se ha Android ou Play Store. Se nao houver, recomende TV Box Android ou Fire Stick.\n\nCodigo Downloader: 8322904.\nTutorial oficial: https://www.youtube.com/watch?v=LBBAbs2-I0c',
  'active',
  '{"official": true, "compatibility_version": 1}'::jsonb
)
on conflict (category, title) do update
set content = excluded.content,
    status = excluded.status,
    metadata = public.knowledge_articles.metadata || excluded.metadata,
    updated_at = now();
