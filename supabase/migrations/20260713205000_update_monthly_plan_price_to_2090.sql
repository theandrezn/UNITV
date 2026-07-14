update public.plans
set price_cents = 2090,
    updated_at = now()
where slug = 'mensal'
  and status = 'active';

update public.knowledge_articles
set content = replace(replace(content, 'R$ 25', 'R$ 20,90'), 'R$25', 'R$20,90'),
    updated_at = now()
where status = 'active'
  and (content like '%R$ 25%' or content like '%R$25%');
