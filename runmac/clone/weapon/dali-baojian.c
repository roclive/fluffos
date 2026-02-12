//dali-baojian.c 大理宝剑
#include <ansi.h>
#include <weapon.h>

inherit SWORD;

void create()
{
	set_name(HIW"大理宝剑"NOR, ({ "dali baojian", "baojian", "jian", "sword" }));
	set_weight(3000);
	if (clonep())
		set_default_object(__FILE__);
	else {
		set("unit", "柄");
		set("long",
HIW"这是一柄大理段氏祖传宝剑，剑身寒光闪闪，锋利无比。\n"
"剑柄上镶嵌着一颗明珠，隐隐有内力流转其中。\n"NOR);
		set("value", 50000);
		set("material", "mithril");
		set("rigidity", 2000);
		set("wield_msg", HIW"$N缓缓拔出$n，剑身寒光一闪，锋芒毕露！\n"NOR);
		set("unwield_msg", "$N将$n插回剑鞘，寒光敛去。\n");
	}
	init_sword(150);
	setup();
}

mixed query_autoload() { return 1; }
void autoload(mixed param) { }

