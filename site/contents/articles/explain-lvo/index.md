---
title: Loop Variable Optimization
author: michael
date: 2019-12-7
template: article.pug
comments: true
---


Loop variable analysis seeks to bake bounds information into the type of the loop induction variable
(the proverbial "i" in yer for-loop). By so doing, bounds checks can be eliminated at runtime. Code
like Kraken's Gaussian Blur test, which applies a kernel over an array of data especially benefits from
this. On that particular test, we get a reduction in runtime of > 10%.

I'd like to explore how this optimization works with a simple example, inspired by Gaussian Blur.
This article should also be helpful for navigating around in the fantastic tool, Turbolizer.
[Here's](https://doar-e.github.io/blog/2019/01/28/introduction-to-turbofan/) a fantastic article that goes into greater depth using Turbolizer to explain a security
issue. [This short section](https://doar-e.github.io/blog/2019/01/28/introduction-to-turbofan/#preparing-turbolizer) explains how to set up Turbolizer. Read that and come back for my
much more humble introduction to the tool...or just stay...it is quite fascinating!

Additionally, here is the original [CL](https://codereview.chromium.org/2164263003) for loop variable analysis.
The tip of tree has been refactored somewhat, but the code remains very much like this.

My example, `r2.js`:

```javascript
const width = 400;
const height = 400;
const kernelSize = 5;
let data = new Array(width * height);

function foo(a) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x > (width - kernelSize)) break;
      data[y + x * width] += 1;
    }
  }
}

foo();
console.time("foo");
for (let r = 0; r < 1000; r++) {
  foo();
}
console.timeEnd("foo");
```

I'm turning off OSR because it complicates the control flow, and turning off loop peeling for the same reason. I get a run time
of about 1900 milliseconds with loop variable analysis on, and about 2000 milliseconds with it off, so a 5% improvement.
Looking at the generated code, I see that all four bounds check deopt points are removed when I allow loop variable analysis
to occur. I'm more interested in focusing on the graph manipulations here, so I just offer the observation that the
optimized code is "larded up" with these overflow checks when we run with `--noturbo-loop-variable`.

The whole command-line for a run with loop analysis and output for Turbolizer is:

```
out/release/d8 r2.js --noturbo-loop-peeling --nouse-osr
    --trace-turbo --trace-turbo-loop
```

And to get a run without the loop analysis just add in `--noturbo-loop-variable`.

The output of `--trace-turbo-loop` is already interesting. We get:

```
Loop variables for loop 16: 19                                                                                                                                           │
Loop variables for loop 50: 53                                                                                                                                           │
New upper bound for 19 (loop 16): 210: NumberConstant[400]                                                                                                               │
New upper bound for 53 (loop 50): 128:
    SpeculativeSafeIntegerSubtract[SignedSmall](210, 211, 84, 124)                                                                    │
New upper bound for 53 (loop 50): 210: NumberConstant[400]                                                                                                               │
Loop (50) variable bounds in addition for phi 53: (0, 396)                                                                                                               │
Loop (50) variable bounds in addition for phi 53: (0, 396)                                                                                                               │
Loop (16) variable bounds in addition for phi 19: (0, 400)                                                                                                               │
Loop (16) variable bounds in addition for phi 19: (0, 400)
```

We can see that two loops have been identified, with Node id's of 16 and 50. The induction variables have been found
to be 19 and 53 respectively. We end up with a bound now incorporated into the type as integer range (0, 400) for
loop 16, and integer range (0, 396) for loop 50. Clearly, these come from variables `width` and `height` in the source.
Notice that the system is clever enough to recognize that loop variable `x` has a smaller range, thanks to
the statement `if (x > (width - kernelSize)) break;`.

This is whats very cool about loop variable analysis. It notices how checks against the loop variable influence control
flow, and uses this information to narrow the range continually. If there were other such statements in the source, they
would be found and incorporated into the type as well.

![](/images/articles/explain-lvo/jake-amazed.png)
*This is how I feel about it.*

# How does loop variable analysis work?

We have a class `LoopVariableOptimizer`. We run it on the graph.
It's first job is to find the induction variables. For each `Loop` node in the graph, we do the following:

## 1) Look at all phis which accept control edges from the loop

If the arithmetic input to the phi (input 1) is one of:

* JSAdd
* NumberAdd
* SpeculativeNumberAdd
* SpeculativeSafeIntegerAdd

Then we go forward with an arithmetic type of `kAddition`. If the arithmetic input is one of:

* JSSubtract
* NumberSubtract
* SpeculativeNumberSubtract
* SpeculativeSafeIntegerSubtract

then we go forward with an arithmetic type of `kSubtraction`. If the arithmetic node has any other opcode we give up at this point.

## 2) Examine the input to the arithmetic node we just looked at

If the first input is
SpeculativeToNumber, JSToNumber or JSToNumberConvertBigInt, then we walk
"through" that node to look at it's own input.

If the input at this point (after the adjustment above, if necessary) is *not the same as the phi*, we give up.

If we can't find an EffectPhi node connected to the loop, we also give up.

We define incr to be the node at input 1 of the arith node.

Finally, having passed all tests, we create an `InductionVariable` with phi, effect_phi, arith, incr, initial and the arithmeticType.
The InductionVariable will gradually have upper and lower bounds attached to it as we walk the graph.

So, to sum up, an InductionVariable has:

* a phi node
* a arith node (input 1 to the phi)
* the increment node (input 0 to the arith node)
* the initial value node (input 0 to the phi)
* A set of lower and upper Bounds. Where a Bound is a node and a strict or non-strict constaint kind (to be explained below).

## Let's do this ourselves with Turbolizer

Start up Turbolizer, and load `turbo-foo-0.json`. Go to the `TFEarlyTrimming` stage of the pipeline.
This is right before `TFTyping` which does the loop variable analysis.

You'll have a big ol' graph. Let's just look at the `Loop` nodes. In the search box type `^Loop$` and hit enter.
Then press `u` or click the little button with the tool-tip "Hide unselected." Then press `r` to relayout
the graph (or press the button with the tool-tip "layout graph."

You should now have something like this:

![](/images/articles/explain-lvo/two-loops.png)

The Loop with id 50 is selected, and you can see a little red marker in the source on the left, indicating that
it's the inner loop. If you click on Loop 16, you'll see the red marker change to that of the outer loop,
with induction variable `y`. Let's restrict our view to Loop 50, and go through the algorithm above.

Step one is *look at all the phis with control edges from the loop.* I select loop 50 and hit the "down" arrow
to select all nodes which take 50 as an input. With a bit of cleanup thanks to frequent use of the "u"
and "r" keys, I end up with:

![](/images/articles/explain-lvo/phi-for-50.png)

Next, we must validate that this is a candidate Phi by looking at the arithmetic input. This is input #1.
Just use the "up" arrow on the selected Phi to show all it's inputs:

![](/images/articles/explain-lvo/phi-for-50-more.png)

Very nice! I see that input 1 is a `SpeculativeSafeIntegerAdd`, which is in the list above. So far, so good!
Helpfully, I also see that the initial value node is a `NumberConstant[0]`. Let's move on. Step 2 is
*Examine the input to the arithmetic node*. The first input must be either the Phi, or a "pass through" node
of SpeculativeToNumber, JSToNumber or JSToNumberConvertBigInt. Happily, we have the Phi:

![](/images/articles/explain-lvo/phi-for-50-valid.png)

The "incr" node is the second input to the `SpeculativeSafeIntegerAdd`. This tells us how much we increment
the Phi by each time through the loop.

Lastly, make sure the Loop has an `EffectPhi` node attached to it. Thinking about it a moment, you can see that
without any "effectful" operations, the loop can't be very meaningful.

So we've passed all tests. Consulting the `--trace-turbo-loop` output again, we validate our work with an air
of satisfaction:

```
...
Loop variables for loop 50: 53                                                                                                                                           │
...
```

*Dear Reader, do the same for the outer `y` loop. Were you able to fully characterize the induction variable,
with it's "arith," "incr" and other nodes? I hope so!*

You'll end up with something like this:

![](/images/articles/explain-lvo/phi-for-16.png)

The Optimizer first finds what it considers to be induction variables (these
are particular Phis in the graph which have a special relationship to a Loop).
It then changes their opcode to be `InductionVariablePhi`. Then it runs the
Typer over the graph. The Typer uses special heuristics to come up with a
better bounded type for the induction variable. Finally, the
InductionVariablePhis are converted back to Phi nodes.

## Algorithm

We run over the graph from start, visiting all control input nodes. We're interested in `Merge`, `Loop`,
`IfFalse`, `IfTrue`, `Start`, `LoopExit`, and we have a default behavior for other control nodes.

Our purpose is to create auxillary data associated with nodes that we call
*Constraints*. These are a tuple of `{Node *left, Node *right, [strict |
nonstrict]}`. For each node we then have a list of constraints.

1. Visiting `Start`: set it's constraints to empty.
1. Visiting `Merge`: set the constraints of the merge to the set of constraints that are common across all
the inputs to the merge.
1. Visiting `Loop`: Detect induction variables (described below), then set the constraints of the loop
to be those of it's first control input.
1. Visiting `IfFalse` and `IfTrue`: Find the branch and condition nodes
  associated with the current node. Get the constraints from the branch.
  Depending on the condition opcode, alter the limits accordingly, then set this
  altered limits variable as the constraint for the current node. The alteration
  (in `AddCmpToLimits`) is to find an induction variable on the right and/or left
  side of the comparison, and push a constraint.

Then we visit backedges from nodes back to loops. Walk each constraint associated with the node. If the left side of the constraint (call it L)
is a phi controlled by the loop, then we look up the induction variable that matches L, and attach the right side of the constraint as an
upper bound for the induction variable.

If the right side of the constraint (call it R) is a phi controlled by the loop, then we look up the induction variable that matches R, and attach
the left side of the constraint as a lower bound on the phi.

### Little example

In Turbolizer, at the `TFEarlyTrimming` stage right before `TFTyping` (and loop variable analysis), we can see a loop.

## Preparing the graph

We go over all the induction variables and for the ones which successfully
obtained useful upper and lower bounds, we change the node to an
`InductionVariablePhi`. We perform surgery on the graph, first adding the
`incr` node at the end of the inputs, then one by one adding all the lower
bounds and all the upper bounds as inputs. So now we have a kind of "super
node" that localizes everything it needs within easy reach.

## Running the Typer

The Typer runs now, given the `LoopVariableOptimizer` as a helper class to return information about induction variables
when typing `InductionVariablePhi` nodes. The graph is typed as it normally is, but this extra information about
induction variables means that we can likely turn the induction variable phis into a range type, ideally in
integer range.

## Restoring the graph

In `LoopVariableOptimizer::ChangeToPhisAndInsertGuards()` we reverse the graph
preparation process, possibly inserting a `TypeGuard` node in case the type of
the backedge does not have the same type as the phi (this is the phi that is
now typed correctly with the results of the analysis). The idea is that the
`TypeGuard` doesn't do anything, it just asserts that the real type of it's
input node is the type that it expresses. (Open question --> should a TypeGuard
always be a narrowing?)

