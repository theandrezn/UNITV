update public.knowledge_articles
set
  title = replace(title, '8322904', '862585'),
  content = replace(content, '8322904', '862585')
where title like '%8322904%'
  or content like '%8322904%';
