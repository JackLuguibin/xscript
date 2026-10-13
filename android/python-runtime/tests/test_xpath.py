import unittest

from xscript.android.tree import run_xpath
from xscript.android.xpath import XPathError, compile_xpath

from test_selector import TREE


def paths(expr):
    return [n.path for n in run_xpath(TREE, expr)]


class XPathTest(unittest.TestCase):
    def test_basic_paths(self):
        self.assertEqual(paths("//TextView[@text='Internet']"), ["0/1/0"])
        self.assertEqual(paths("//LinearLayout/Switch"), ["0/1/2"])
        self.assertEqual(paths("/*"), ["0"])
        self.assertEqual(paths("/FrameLayout/LinearLayout"), ["0/1"])
        self.assertEqual(paths("//android.widget.Switch"), ["0/1/2"])

    def test_attribute_aliases(self):
        self.assertEqual(paths("//*[@resource-id='com.android.settings:id/search']"), ["0/0"])
        self.assertEqual(paths("//*[@content-desc='Search settings']"), ["0/0"])
        self.assertEqual(paths("//*[@class='android.widget.Switch']"), ["0/1/2"])
        self.assertEqual(paths("//*[@checked='true']"), ["0/1/2"])
        self.assertEqual(paths("//LinearLayout[@child-count>2]"), ["0/1"])

    def test_functions(self):
        self.assertEqual(paths("//*[contains(@text,'Wi')]"), ["0/1/1"])
        self.assertEqual(paths("//TextView[starts-with(text(),'Int')]"), ["0/1/0"])
        self.assertEqual(paths("//*[ends-with(@text,'spot')]"), ["0/1/2"])
        self.assertEqual(paths("//*[matches(@text,'^Wi.?Fi')]"), ["0/1/1"])
        self.assertEqual(paths("//*[string-length(@text)=6]"), ["0/0"])
        self.assertEqual(paths("//*[count(*)=3]"), ["0/1"])
        self.assertEqual(paths("//*[normalize-space(concat(' ', @text))='Hotspot']"), ["0/1/2"])

    def test_positions(self):
        self.assertEqual(paths("//LinearLayout/*[2]"), ["0/1/1"])
        self.assertEqual(paths("//LinearLayout/*[last()]"), ["0/1/2"])
        self.assertEqual(paths("//LinearLayout/*[last()-1]"), ["0/1/1"])
        self.assertEqual(paths("//LinearLayout/*[position()<3]"), ["0/1/0", "0/1/1"])
        # [1] applies per parent under //, but (//x)[1] is the first in the document
        self.assertEqual(paths("//TextView[1]"), ["0/0", "0/1/0"])
        self.assertEqual(paths("(//TextView)[1]"), ["0/0"])
        self.assertEqual(paths("(//TextView)[last()]"), ["0/1/1"])

    def test_boolean_logic(self):
        self.assertEqual(paths("//*[@clickable='true' and contains(@text,'e')]"), ["0/0", "0/1/0"])
        self.assertEqual(paths("//*[@clickable='true' and contains(@text,'net')]"), ["0/1/0"])
        self.assertEqual(paths("//*[@text='Internet' or @text='Hotspot']"), ["0/1/0", "0/1/2"])
        self.assertEqual(paths("//TextView[not(@clickable='true')]"), [])
        self.assertEqual(paths("//*[@text!='' and @index='0']"), ["0/0", "0/1/0"])
        self.assertEqual(paths("//*[@text!='' and @index=2]"), ["0/1/2"])

    def test_axes(self):
        self.assertEqual(paths("//*[@text='Internet']/.."), ["0/1"])
        self.assertEqual(paths("//*[@text='Internet']/parent::*"), ["0/1"])
        self.assertEqual(paths("//*[@text='Internet']/ancestor::*"), ["0", "0/1"])
        self.assertEqual(paths("//*[@text='Internet']/ancestor::*[1]"), ["0/1"])
        self.assertEqual(paths("//*[@text='Internet']/following-sibling::*"), ["0/1/1", "0/1/2"])
        self.assertEqual(paths("//*[@text='Hotspot']/preceding-sibling::*[1]"), ["0/1/1"])
        self.assertEqual(paths("//LinearLayout/descendant::Switch"), ["0/1/2"])
        self.assertEqual(paths("//*[@text='Network']/self::LinearLayout"), ["0/1"])

    def test_nested_path_predicate_and_union(self):
        self.assertEqual(paths("//LinearLayout[.//Switch[@checked='true']]"), ["0/1"])
        self.assertEqual(paths("//*[./TextView[@text='Search']]"), ["0"])
        self.assertEqual(paths("//Switch | //FrameLayout"), ["0", "0/1/2"])

    def test_relative_after_group(self):
        self.assertEqual(paths("(//LinearLayout)[1]/TextView"), ["0/1/0", "0/1/1"])
        self.assertEqual(paths("(//LinearLayout)[1]//Switch"), ["0/1/2"])

    def test_errors(self):
        for bad in ("", "//", "//TextView[", "//*[@text='x'", "//foo::bar", "//*[unknown()]", "'abc'"):
            with self.assertRaises(XPathError, msg=bad):
                run_xpath(TREE, bad)

    def test_cache(self):
        self.assertIs(compile_xpath("//TextView"), compile_xpath("//TextView"))

    def test_empty_tree(self):
        self.assertEqual([n.path for n in run_xpath([], "//TextView")], [])


if __name__ == "__main__":
    unittest.main()
